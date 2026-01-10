// @ts-nocheck
import Renderer from "../../../lib/renderer/Renderer.js"
import os from "node:os"
import lodash from "lodash"
import puppeteer from "puppeteer"
import { ulid } from "ulid"
import timers from "node:timers/promises"
// 暂时保留对原config的兼容
import cfg from "../../../lib/config/config.js"
import { redisPath } from './constNum.js'
import { tempPath } from "./path.js"
import logger from "../components/Logger.js"
const _path = process.cwd()
// mac地址
let mac = ""

export default class Puppeteer extends Renderer {
    /**
     * 
     * @param {any} config 
     * @param {string} browserId 
     */
    constructor(config, browserId) {
        super({
            id: "puppeteer",
            type: "image",
            render: "screenshot",
        })
        /** @type {import('puppeteer').Browser | false} */
        this.browser = false
        /** @type {Promise<import('puppeteer').Browser | false> | null} */
        this._browserInitPromise = null
        /** @type {Promise<import('puppeteer').Browser | false> | null} */
        this._restartPromise = null

        /** 当前正在渲染的任务（仅用于日志与重启保护） */
        this._activeShots = new Set()
        /** 截图数达到时重启浏览器 避免生成速度越来越慢 */
        this.restartNum = 100
        /** 截图次数 */
        this.renderNum = 0

        /** 并发 worker 数（原 renderNum；现在语义为页面并发数） */
        this.poolSize = Math.max(1, Number(config.poolSize || 1))
        /** 等待 worker 的超时时间（ms），用于替代上层 busy-wait */
        this.queueTimeout = Math.max(0, Number(config.queueTimeout || 0))
        /** 等待队列上限（0 表示不限制） */
        this.queueMax = Math.max(0, Number(config.queueMax || 0))

        /** @type {number[]} 空闲 workerId 队列 */
        this._idleWorkers = Array.from({ length: this.poolSize }, (_, i) => i)
        /** @type {Array<{ resolve: (id:number)=>void, reject:(err:Error)=>void, timer?: NodeJS.Timeout }>} */
        this._waiters = []

        this.config = {
            headless: "new",
            args: ["--disable-gpu", "--disable-setuid-sandbox", "--no-sandbox", "--no-zygote"],
            ...config,
        }
        if (config.chromiumPath || cfg?.bot?.chromium_path)
            /** chromium其他路径 */
            this.config.executablePath = config.chromiumPath || cfg?.bot?.chromium_path
        if (config.puppeteerWS || cfg?.bot?.puppeteer_ws)
            /** chromium其他路径 */
            this.config.wsEndpoint = config.puppeteerWS || cfg?.bot?.puppeteer_ws
        /** puppeteer超时超时时间 */
        this.puppeteerTimeout = config.puppeteerTimeout || cfg?.bot?.puppeteer_timeout || 0
        this.pageGotoParams = config.pageGotoParams || {
            timeout: 120000,
            waitUntil: ["domcontentloaded", "load"],
        }
        this.browserId = browserId
    }

    /**
     * 初始化chromium
     */
    async browserInit() {
        if (this.browser) return this.browser
        if (this._browserInitPromise) return await this._browserInitPromise

        this._browserInitPromise = (async () => {
            logger.info("puppeteer Chromium 启动中...")

            let connectFlag = false
            try {
                // 获取Mac地址
                if (!mac) {
                    mac = await this.getMac()
                }
                this.browserMacKey = `${redisPath}:browserWSEndpoint:${this.browserId}:${mac}`

                // 是否有browser实例
                const browserUrl = (await redis.get(this.browserMacKey)) || this.config.wsEndpoint
                if (browserUrl) {
                    try {
                        const browserWSEndpoint = await puppeteer.connect({ browserWSEndpoint: browserUrl })
                        // 如果有实例，直接使用
                        if (browserWSEndpoint) {
                            this.browser = browserWSEndpoint
                            connectFlag = true
                        }
                        logger.info(`puppeteer Chromium 连接成功 ${browserUrl}`)
                    } catch (err) {
                        await redis.del(this.browserMacKey)
                    }
                }
            } catch { }

            if (!this.browser || !connectFlag) {
                let config = { ...this.config, userDataDir: `${tempPath}/puppeteer/${ulid()}` }
                // 如果没有实例，初始化puppeteer
                this.browser = await puppeteer.launch(config).catch(async (err, trace) => {
                    const errMsg = err.toString() + (trace ? trace.toString() : "")
                    logger.error(err, trace)
                    if (errMsg.includes("Could not find Chromium"))
                        logger.error(
                            "没有正确安装 Chromium，可以尝试执行安装命令：node node_modules/puppeteer/install.js",
                        )
                    else if (errMsg.includes("cannot open shared object file"))
                        logger.error("没有正确安装 Chromium 运行库")
                    return false
                })
            }

            if (!this.browser) {
                logger.error("puppeteer Chromium 启动失败")
                return false
            }
            if (!connectFlag) {
                logger.info(`puppeteer Chromium 启动成功 ${this.browser.wsEndpoint()}`)
                if (this.browserMacKey) {
                    // 缓存一下实例30天
                    const expireTime = 60 * 60 * 24 * 30
                    await redis.set(this.browserMacKey, this.browser.wsEndpoint(), { EX: expireTime })
                }
            }

            /** 监听Chromium实例是否断开 */
            this.browser.on("disconnected", () => this.restart(true))

            return this.browser
        })()
            .finally(() => {
                this._browserInitPromise = null
            })

        return await this._browserInitPromise
    }

    // 获取Mac地址
    getMac() {
        let mac = "00:00:00:00:00:00"
        try {
            const network = os.networkInterfaces()
            let macFlag = false
            for (const a in network) {
                for (const i of network[a]) {
                    if (i.mac && i.mac !== mac) {
                        macFlag = true
                        mac = i.mac
                        break
                    }
                }
                if (macFlag) {
                    break
                }
            }
        } catch (e) { }
        mac = mac.replace(/:/g, "")
        return mac
    }

    /**
     * 申请一个空闲 worker（用于并发限流与避免 saveId 冲突）
     * @returns {Promise<number>}
     */
    async _acquireWorker() {
        if (this._idleWorkers.length > 0) {
            // @ts-ignore
            return this._idleWorkers.shift()
        }

        if (this.queueMax > 0 && this._waiters.length >= this.queueMax) {
            throw new Error("渲染队列过长，请稍后再试")
        }

        return await new Promise((resolve, reject) => {
            /** @type {{ resolve: (id:number)=>void, reject:(err:Error)=>void, timer?: NodeJS.Timeout }} */
            const waiter = { resolve, reject }
            if (this.queueTimeout > 0) {
                waiter.timer = setTimeout(() => {
                    const idx = this._waiters.indexOf(waiter)
                    if (idx >= 0) this._waiters.splice(idx, 1)
                    reject(new Error("等待渲染超时，请稍后重试"))
                }, this.queueTimeout)
            }
            this._waiters.push(waiter)
        })
    }

    /**
     * 释放 worker
     * @param {number} workerId
     */
    _releaseWorker(workerId) {
        // 尽量唤醒最早等待的任务（FIFO）
        const waiter = this._waiters.shift()
        if (waiter) {
            if (waiter.timer) clearTimeout(waiter.timer)
            waiter.resolve(workerId)
            return
        }
        this._idleWorkers.push(workerId)
    }

    /**
     * 等待页面资源就绪（字体与图片）
     * @param {import('puppeteer').Page} page
     */
    async _waitForPageReady(page) {
        try {
            await page.evaluate(async () => {
                // 等待字体加载完成（避免偶发缺字/字体替换）
                // @ts-ignore
                if (document.fonts && document.fonts.ready) {
                    try {
                        // @ts-ignore
                        await document.fonts.ready
                    } catch { }
                }

                // 等待页面内图片加载完成
                const imgs = Array.from(document.images || [])
                await Promise.all(imgs.map(img => new Promise(resolve => {
                    if (!img) return resolve(true)
                    if (img.complete) return resolve(true)
                    const done = () => resolve(true)
                    img.addEventListener('load', done, { once: true })
                    img.addEventListener('error', done, { once: true })
                })))
            })
        } catch {
            // 这里属于优化等待逻辑，失败不应影响渲染主流程
        }
    }

    /**
     * `chromium` 截图
     * @param name
     * @param data 模板参数
     * @param data.tplFile 模板路径，必传
     * @param data.saveId  生成html名称，为空name代替
     * @param data.imgType  screenshot参数，生成图片类型：jpeg，png
     * @param data.quality  screenshot参数，图片质量 0-100，jpeg是可传，默认90
     * @param data.omitBackground  screenshot参数，隐藏默认的白色背景，背景透明。默认不透明
     * @param data.path   screenshot参数，截图保存路径。截图图片类型将从文件扩展名推断出来。如果是相对路径，则从当前路径解析。如果没有指定路径，图片将不会保存到硬盘。
     * @param data.multiPage 是否分页截图，默认false
     * @param data.multiPageHeight 分页状态下页面高度，默认4000
     * @param data.pageGotoParams 页面goto时的参数
     * @return img 不做segment包裹
     */
    async screenshot(name, data = {}) {
        const browser = await this.browserInit()
        if (!browser) return false

        const workerId = await this._acquireWorker()
        const shotToken = `${name}:${data.saveId || ""}:${workerId}:${Date.now()}`
        this._activeShots.add(shotToken)

        const pageHeight = data.multiPageHeight || 4000

        // 使用 workerId 固定后缀，保证并发下不会覆盖同名 html 文件，且不会无限增长
        data.saveId = `${data.saveId || name}_${workerId}`

        const savePath = this.dealTpl(name, data)
        if (!savePath) {
            this._activeShots.delete(shotToken)
            this._releaseWorker(workerId)
            return false
        }

        let buff = ""
        const start = Date.now()

        let ret = []
        /** @type {import('puppeteer').Page | null} */
        let page = null

        let timeoutTimer
        const puppeteerTimeout = this.puppeteerTimeout

        try {
            page = await browser.newPage()

            const pageGotoParams = { ...this.pageGotoParams, ...(data.pageGotoParams || {}) }
            const url = `file://${_path}${lodash.trim(savePath, ".")}`

            const run = async () => {
                await page.goto(url, pageGotoParams)
                await this._waitForPageReady(page)

                const body = (await page.$("#container")) || (await page.$("body"))

                // 计算页面高度
                const boundingBox = await body.boundingBox()
                // 分页数
                let num = 1

                const randData = {
                    type: data.imgType || "jpeg",
                    omitBackground: data.omitBackground || false,
                    quality: data.quality || 90,
                    path: data.path || "",
                }

                if (data.multiPage) {
                    randData.type = "jpeg"
                    num = Math.round(boundingBox.height / pageHeight) || 1
                }

                if (data.imgType === "png") delete randData.quality

                if (!data.multiPage) {
                    buff = await body.screenshot(randData)
                    if (!Buffer.isBuffer(buff)) buff = Buffer.from(buff)

                    this.renderNum++

                    /** 计算图片大小 */
                    const kb = (buff.length / 1024).toFixed(2) + "KB"
                    logger.mark(
                        `[图片生成][${name}][${this.renderNum}次] ${kb} ${logger.green(`${Date.now() - start}ms`)}`,
                    )
                    ret.push(buff)
                } else {
                    // 分片截图
                    if (num > 1) {
                        await page.setViewport({
                            width: boundingBox.width,
                            height: pageHeight + 100,
                        })
                    }
                    for (let i = 1; i <= num; i++) {
                        if (i !== 1 && i === num)
                            await page.setViewport({
                                width: boundingBox.width,
                                height: parseInt(boundingBox.height) - pageHeight * (num - 1),
                            })

                        if (i !== 1 && i <= num)
                            await page.evaluate(pageHeight => window.scrollBy(0, pageHeight), pageHeight)

                        if (num === 1) buff = await body.screenshot(randData)
                        else buff = await page.screenshot(randData)
                        if (!Buffer.isBuffer(buff)) buff = Buffer.from(buff)

                        if (num > 2) await timers.setTimeout(200)

                        this.renderNum++

                        /** 计算图片大小 */
                        const kb = (buff.length / 1024).toFixed(2) + "KB"
                        logger.mark(`[图片生成][${name}][${i}/${num}] ${kb}`)
                        ret.push(buff)
                    }
                    if (num > 1) {
                        logger.mark(`[图片生成][${name}] 处理完成`)
                    }
                }
            }

            const runPromise = run()
            const timeoutPromise = puppeteerTimeout > 0
                ? new Promise((_, reject) => {
                    timeoutTimer = setTimeout(() => reject(new Error("截图超时")), puppeteerTimeout)
                })
                : null

            await (timeoutPromise ? Promise.race([runPromise, timeoutPromise]) : runPromise)
            if (timeoutPromise) {
                // 避免超时后 runPromise 产生未处理的 rejection
                runPromise.catch(() => { })
            }
        } catch (err) {
            logger.error(`[图片生成][${name}] 图片生成失败`, err)
            // 单任务失败不应无条件强制重启（并发下会雪崩）
            const errMsg = err?.toString?.() || ""
            const isConnected = typeof browser?.isConnected === 'function' ? browser.isConnected() : true
            const browserDisconnected = !isConnected || errMsg.includes("Target closed") || errMsg.includes("Session closed")
            if (browserDisconnected) {
                this.restart(true)
            }
            ret = []
            return false
        } finally {
            if (timeoutTimer) clearTimeout(timeoutTimer)
            if (page) page.close().catch(err => logger.error(err))
            this._activeShots.delete(shotToken)
            this._releaseWorker(workerId)
        }

        if (ret.length === 0 || !ret[0]) {
            logger.error(`[图片生成][${name}] 图片生成为空`)
            return false
        }

        this.restart()
        return data.multiPage ? ret : ret[0]
    }

    /** 重启 */
    restart(force = false) {
        /** 截图超过重启数时，自动关闭重启浏览器，避免生成速度越来越慢 */
        if (this._restartPromise) return this._restartPromise
        if (!this.browser?.close) return

        // 非强制重启：仅在无并发渲染时执行，避免影响其它任务
        if (!force) {
            if (this.renderNum % this.restartNum !== 0) return
            if (this._activeShots.size > 0) return
        }

        logger.info(`puppeteer Chromium ${force ? "强制" : ""}关闭重启...`)

        const browser = this.browser
        this.browser = false

        this._restartPromise = (async () => {
            await this.stop(browser)
            return await this.browserInit()
        })().finally(() => {
            this._restartPromise = null
        })

        return this._restartPromise
    }

    async stop(browser) {
        try {
            await browser.close()
        } catch (err) {
            logger.error("puppeteer Chromium 关闭错误", err)
        }
    }
}
