import readFile from './getFile.js'
import { DlcInfoPath, configPath, imgPath, infoPath, originalIllPath, ortherIllPath, oldInfoPath } from './path.js'
import path from 'path'
import Config from '../components/Config.js'
import SongsInfo from './class/SongsInfo.js'
import fs from 'fs'
import { allLevel, Level, MAX_DIFFICULTY } from './constNum.js'
import chokidar from 'chokidar'
import fCompute from './fCompute.js'
import logger from '../components/Logger.js'
import Chart from './class/Chart.js'

/** URL 判定（用于区分本地文件名与在线地址） */
const URL_REG = /^(?:(http|https|ftp):\/\/)((?:[\w-]+\.)+[a-z0-9]+)((?:\/[^/?#]*)+)?(\?[^#]+)?(#.+)?$/i
/** infoPath 监听防抖，避免批量更新触发频繁全量重载 */
const INFO_WATCH_DEBOUNCE_MS = 300


export default new class getInfo {



    /**
     * @typedef {Object} updatedChartObject
     * @property {number|number[]|undefined} tap
     * @property {number|number[]|undefined} drag
     * @property {number|number[]|undefined} hold
     * @property {number|number[]|undefined} flick
     * @property {number|number[]|undefined} difficulty
     * @property {number|number[]|undefined} combo
     * @property {boolean|undefined} isNew
     */

    constructor() {



        /**
         * 难度映射
         * @type {allLevelKind[]}
         */
        this.allLevel = allLevel

        /**
         * 难度映射
         * @type {levelKind[]}
         */
        this.Level = Level

        /**
         * @type {string[]}
         * @description Tips
         */
        this.tips = []


        /**
         * @type {{[key:idString]:Partial<SongsInfo> | undefined}}
         * @description 原版信息
         */
        this.ori_info = {}
        /**
         * @type {{[key:idString]:songString}}
         * @description 通过id获取曲名
         */
        this.songsid = {}
        /**
         * @type {{[key:songString]:idString}}
         * @description 原曲名称获取id
         */
        this.idssong = {}
        /**
         * @type {idString[]}
         * @description 含有曲绘的曲目列表，id名称
         */
        this.illlist = []

        /**
         * @type {{[key:string]: string[]}}
         * @description 章节别名，以别名为key，内容为章节名
         */
        this.chapNick = {}

        /**
         * 按dif分的info
         * @type {Record<number, Chart[]>}
         */
        this.info_by_difficulty = {}


        /**
         * @type {idString[]}
         */
        this.updatedSong = []


        /**
         * @type {Record<idString, Partial<Record<levelKind, updatedChartObject>>>}
         */
        this.updatedChart = {}

        /** 性能优化：缓存 all_info 结果，避免在热路径频繁对象展开拷贝 */
        /** @type {Map<string, Record<idString, any>>} */
        this._allInfoCache = new Map()
        /** 性能优化：缓存曲绘/资源路径解析结果，减少重复 existsSync */
        /** @type {Map<string, string>} */
        this._illCache = new Map()
        /** @type {Map<string, string>} */
        this._chartImgCache = new Map()
        /** @type {Map<string, string>} */
        this._tableImgCache = new Map()
        /** @type {Map<string, string>} */
        this._chapIllCache = new Map()

        /** watchInfoPath：防止重复注册 chokidar watcher 导致句柄泄漏 */
        /** @type {any} */
        this._infoPathWatcher = null
        /** @type {NodeJS.Timeout | null} */
        this._infoPathReloadTimer = null
    }

    static initIng = false

    /**
     * 清理内部缓存（用于 init/配置变更后，避免返回旧数据）
     * @param {string} [reason]
     */
    clearCache(reason = '') {
        try {
            this._allInfoCache?.clear?.()
            this._illCache?.clear?.()
            this._chartImgCache?.clear?.()
            this._tableImgCache?.clear?.()
            this._chapIllCache?.clear?.()
            if (Config.getUserCfg('config', 'debug') > 3 && reason) {
                logger.info(`[phi-plugin] 清理缓存: ${reason}`)
            }
        } catch (err) {
            // 清缓存失败不应影响主流程
            logger.warn(`[phi-plugin] 清理缓存失败: ${reason}`)
            logger.warn(err)
        }
    }

    /**
     * 快速判断曲目是否存在（避免为了校验而 new SongsInfo / 合并大对象）
     * @param {idString} id
     * @param {boolean} [original=false] 仅使用原版曲库（忽略 otherinfo 配置）
     */
    hasInfo(id, original = false) {
        const mode = original ? 0 : Config.getUserCfg('config', 'otherinfo')
        if (mode !== 2) {
            if (this.ori_info?.[id] || this.sp_info?.[id]) return true
        }
        if (mode === 1 || mode === 2) {
            const other = Config.getUserCfg('otherinfo')
            return !!other?.[id]
        }
        return false
    }

    async init() {

        if (Config.getUserCfg('config', 'watchInfoPath')) {
            if (!this._infoPathWatcher) {
                this._infoPathWatcher = chokidar.watch(infoPath)
                this._infoPathWatcher.on('change', () => {
                    // 防抖：批量写入时只重载一次
                    if (this._infoPathReloadTimer) clearTimeout(this._infoPathReloadTimer)
                    this._infoPathReloadTimer = setTimeout(() => {
                        this._infoPathReloadTimer = null
                        this.init()
                    }, INFO_WATCH_DEBOUNCE_MS)
                })
            }
        } else if (this._infoPathWatcher) {
            // 配置关闭后释放 watcher，避免句柄泄漏
            try {
                this._infoPathWatcher.close?.()
            } catch { }
            this._infoPathWatcher = null
        }
        if (!fs.existsSync('./plugins/phi-plugin/resources/original_ill/.git')) {
            logger.error(`[phi-plugin] 未下载曲绘文件，建议使用 /phi downill 命令进行下载`)
        }

        if (this.initIng) return

        logger.info(`[phi-plugin]初始化曲目信息`)

        this.initIng = true
        this.clearCache('getInfo.init')

        /**
         * @type {Record<string, string[]>}
         * @description 扩增曲目信息
         **/
        this.DLC_Info = {}
        let files = fs.readdirSync(DlcInfoPath).filter(file => file.endsWith('.json'))
        for (const file of files) {
            this.DLC_Info[path.basename(file, '.json')] = await readFile.FileReader(path.join(DlcInfoPath, file))
        }

        /**
         * @type {{id: string, name:string}[]}
         * @description 头像id
         */
        let csv_avatar = await readFile.FileReader(path.join(infoPath, 'avatar.csv'))

        /**
         * @type {string[]}
         */
        this.avatarid = []

        for (let i in csv_avatar) {
            this.avatarid.push(csv_avatar[i].id)
        }

        /**
         * @type {string[]}
         * @description Tips
         */
        this.tips = await readFile.FileReader(path.join(infoPath, 'tips.yaml'))

        /**自定义信息 */
        let user_song = Config.getUserCfg('config', 'otherinfo')
        if (Config.getUserCfg('config', 'otherinfo')) {
            for (let i in user_song) {
                if (user_song[i]['illustration_big']) {
                    this.illlist.push(user_song[i].song)
                }
            }
        }

        /**
         * @type {Record<idString, SongsInfo>}
         * @description SP信息
         */
        const sp_json = (await readFile.FileReader(path.join(infoPath, 'spinfo.json')))

        /**
         * @type {Record<idString, SongsInfo>}
         * @description SP信息
         */
        this.sp_info = {}

        for (let i of fCompute.objectKeys(sp_json)) {
            const id = /** @type {idString} */(i + '.0');
            this.sp_info[id] = { ...sp_json[i] }
            this.sp_info[id].sp_vis = true
            this.sp_info[id].id = id
            if (this.sp_info[id]?.illustration) {
                this.illlist.push(this.sp_info[id].id)
            }
        }

        /**最高定数 */
        this.MAX_DIFFICULTY = 0

        /**
         * 所有曲目曲名列表
         * @type {songString[]}
         */
        this.songlist = []

        /**
         * 曲目id列表
         * @type {idString[]}
         */
        this.idList = []

        /**
         * @typedef {Object} notesInfoObject
         * @property {number} m MaxTime
         * @property {[tap: number, drag: number, hold: number, flick: number, tot: number][]} d note分布 [tap,drag,hold,flick,tot]
         * @property {[number,number,number,number]} t note统计 [tap,drag,hold,flick]
         */
        /**
         * note统计
         * @type {{[x:idStringWithout0]:Record<levelKind, notesInfoObject>}}
         */
        let notesInfo = await readFile.FileReader(path.join(infoPath, 'notesInfo.json'))

        /**
         * @typedef {Object} csvInfoObject
         * @property {idStringWithout0} id 曲目id
         * @property {songString} song 曲目名称
         * @property {string} composer 作曲
         * @property {string} illustrator 插画师
         * @property {string} EZ EZ难度谱师
         * @property {string} HD HD难度谱师
         * @property {string} IN IN难度谱师
         * @property {string|undefined} AT AT难度谱师
         */
        /**
         * 信息文件
         * @type {csvInfoObject[]}
         */
        let CsvInfo = await readFile.FileReader(path.join(infoPath, 'info.csv'))
        let Csvdif = await readFile.FileReader(path.join(infoPath, 'difficulty.csv'))
        let Jsoninfo = await readFile.FileReader(path.join(infoPath, 'infolist.json'))

        let oldDif = await readFile.FileReader(path.join(oldInfoPath, 'difficulty.csv'))
        /**
         * note统计
         * @type {{[x:idStringWithout0]:Record<levelKind, notesInfoObject>}}
         */
        let oldNotes = await readFile.FileReader(path.join(oldInfoPath, 'notesInfo.json'))
        /**
         * @type {Record<idStringWithout0, Record<levelKind, number>>}
         */
        let OldDifList = {}
        for (let i in oldDif) {
            OldDifList[oldDif[i].id] = oldDif[i]
        }


        // console.info(CsvInfo, Csvdif, Jsoninfo)
        for (let i = 0; i < CsvInfo.length; i++) {

            const id = /**@type {idString} */(CsvInfo[i].id + '.0')
            const idWithout0 = CsvInfo[i].id

            /**比较新曲部分 */
            if (!OldDifList[idWithout0]) {
                this.updatedSong.push(id)
            }

            switch (idWithout0) {
                case 'AnotherMe.DAAN': {
                    CsvInfo[i].song = /** @type {songString} */('Another Me (KALPA)');
                    break;
                }
                case 'AnotherMe.NeutralMoon': {
                    CsvInfo[i].song = /** @type {songString} */('Another Me (Rising Sun Traxx)');
                    break;
                }
                default: {
                    break;
                }
            }


            this.songsid[id] = CsvInfo[i].song
            this.idssong[CsvInfo[i].song] = id

            this.ori_info[id] = { ...Jsoninfo[CsvInfo[i].id] }
            if (!this.ori_info[id]) {
                this.ori_info[id] = { id: id, song: CsvInfo[i].song, chapter: '', bpm: '', length: '', chart: {} }
                logger.mark(`[phi-plugin]曲目详情未更新：${id}`)
            }
            this.ori_info[id].id = id
            this.ori_info[id].song = CsvInfo[i].song
            this.ori_info[id].composer = CsvInfo[i].composer
            this.ori_info[id].illustrator = CsvInfo[i].illustrator
            this.ori_info[id].chart = {}
            for (let level of this.Level) {

                if (CsvInfo[i][level]) {

                    /**比较新曲部分 */
                    if (OldDifList[idWithout0]) {
                        if (!OldDifList[idWithout0][level] || OldDifList[idWithout0][level] != Csvdif[i][level] || JSON.stringify(oldNotes[idWithout0][level].t) != JSON.stringify(notesInfo[idWithout0][level].t)) {
                            /**
                             * @type {updatedChartObject}
                             */
                            let tem = {
                                tap: undefined,
                                drag: undefined,
                                hold: undefined,
                                flick: undefined,
                                difficulty: undefined,
                                combo: undefined,
                                isNew: undefined
                            }
                            if (!OldDifList[CsvInfo[i].id][level]) {
                                Object.assign(tem, {
                                    tap: notesInfo[idWithout0][level].t[0],
                                    drag: notesInfo[idWithout0][level].t[1],
                                    hold: notesInfo[idWithout0][level].t[2],
                                    flick: notesInfo[idWithout0][level].t[3],
                                    difficulty: Csvdif[i][level],
                                    combo: notesInfo[idWithout0][level].t[0] + notesInfo[idWithout0][level].t[1] + notesInfo[idWithout0][level].t[2] + notesInfo[idWithout0][level].t[3],
                                    isNew: true
                                })
                            } else {
                                if (OldDifList[idWithout0][level] != Csvdif[i][level]) {
                                    Object.assign(tem, { difficulty: [OldDifList[idWithout0][level], Csvdif[i][level]] })
                                }
                                if (oldNotes[idWithout0][level].t[0] != notesInfo[idWithout0][level].t[0]) {
                                    Object.assign(tem, { tap: [oldNotes[idWithout0][level].t[0], notesInfo[idWithout0][level].t[0]] })
                                }
                                if (oldNotes[idWithout0][level].t[1] != notesInfo[idWithout0][level].t[1]) {
                                    Object.assign(tem, { drag: [oldNotes[idWithout0][level].t[1], notesInfo[idWithout0][level].t[1]] })
                                }
                                if (oldNotes[idWithout0][level].t[2] != notesInfo[idWithout0][level].t[2]) {
                                    Object.assign(tem, { hold: [oldNotes[idWithout0][level].t[2], notesInfo[idWithout0][level].t[2]] })
                                }
                                if (oldNotes[idWithout0][level].t[3] != notesInfo[idWithout0][level].t[3]) {
                                    Object.assign(tem, { flick: [oldNotes[idWithout0][level].t[3], notesInfo[idWithout0][level].t[3]] })
                                }
                                let oldCombo = oldNotes[idWithout0][level].t[0] + oldNotes[idWithout0][level].t[1] + oldNotes[idWithout0][level].t[2] + oldNotes[idWithout0][level].t[3]
                                let newCombo = notesInfo[idWithout0][level].t[0] + notesInfo[idWithout0][level].t[1] + notesInfo[idWithout0][level].t[2] + notesInfo[idWithout0][level].t[3]
                                if (oldCombo != newCombo) {
                                    Object.assign(tem, { combo: [oldCombo, newCombo] })
                                }
                            }
                            if (!this.updatedChart[id]) {
                                this.updatedChart[id] = {}
                            }
                            this.updatedChart[id][level] = tem
                        }
                    }

                    this.ori_info[id].chart[level] = {
                        id: id,
                        rank: level,
                        charter: CsvInfo[i][level] || '',
                        difficulty: Number(Csvdif[i][level]),
                        tap: notesInfo[idWithout0][level].t[0],
                        drag: notesInfo[idWithout0][level].t[1],
                        hold: notesInfo[idWithout0][level].t[2],
                        flick: notesInfo[idWithout0][level].t[3],
                        combo: notesInfo[idWithout0][level].t[0] + notesInfo[idWithout0][level].t[1] + notesInfo[idWithout0][level].t[2] + notesInfo[idWithout0][level].t[3],
                        maxTime: notesInfo[idWithout0][level].m,
                        distribution: notesInfo[idWithout0][level].d
                    }

                    /**最高定数 */
                    this.MAX_DIFFICULTY = Math.max(this.MAX_DIFFICULTY, Number(Csvdif[i][level]))
                }
            }
            if (Jsoninfo[id]?.chart) {
                this.ori_info[id].chart = { ...this.ori_info[id].chart, ...Jsoninfo[id].chart }
            }
            this.illlist.push(id)
            this.songlist.push(this.ori_info[id].song)
            this.idList.push(id)
        }


        if (this.MAX_DIFFICULTY != MAX_DIFFICULTY) {
            console.error('[phi-plugin] MAX_DIFFICULTY 常量未更新，请回报作者！', MAX_DIFFICULTY, this.MAX_DIFFICULTY)
        }

        /**
         * 曲目别名列表 (id不带.0)
         * @type {Record<idStringWithout0, string[]>}
         */
        let nicklistTemp = await readFile.FileReader(path.join(infoPath, 'nicklist.yaml'))
        /** 
         * 默认别名，以id为key
         * @type {Record<idString, string[]>} 
         **/
        this.nicklist = {}
        /**
         * 以别名为key
         * @type {Record<string, idString[]>}
         */
        this.songnick = {}


        for (let idWithout0 of fCompute.objectKeys(nicklistTemp)) {
            const id = idWithout0ToIdWith0(idWithout0);
            this.nicklist[id] = nicklistTemp[idWithout0]

            for (let item of nicklistTemp[idWithout0]) {
                if (!this.songnick[item]) {
                    this.songnick[item] = [id]
                } else {
                    this.songnick[item].push(id)
                }
            }
        }

        /**
         * @type {{[key:string]: string[]}}
         * @description 章节列表，以章节名为key，内容为别名
         */
        this.chapList = await readFile.FileReader(path.join(infoPath, 'chaplist.yaml'))

        for (let i in this.chapList) {
            for (let item of this.chapList[i]) {
                if (this.chapNick[item]) {
                    this.chapNick[item].push(i)
                } else {
                    this.chapNick[item] = [i]
                }
            }
        }

        /**
         * jrrp
         * @type {Record<'good'|'bad'|'common', string[]>}
         */
        this.word = await readFile.FileReader(path.join(infoPath, 'jrrp.json'))

        for (let songId of this.idList) {
            for (let level of this.allLevel) {
                let info = this.ori_info[songId]
                if (!info?.chart?.[level]?.difficulty) continue;
                if (this.info_by_difficulty[info.chart[level].difficulty]) {
                    this.info_by_difficulty[info.chart[level].difficulty].push({
                        ...info.chart[level],
                    })
                } else {
                    this.info_by_difficulty[info.chart[level].difficulty] = [{
                        ...info.chart[level],
                    }]
                }
            }
        }

        this.initIng = false
        logger.info(`[phi-plugin]初始化曲目信息完成`)
    }

    /**
     * 
     * @param {idString} id 原曲曲名
     * @param {boolean} [original=false] 仅使用原版
     * @returns {SongsInfo | undefined} 曲目信息对象
     */
    info(id, original = false) {
        const mode = original ? 0 : Config.getUserCfg('config', 'otherinfo')
        /** @type {any} */
        let raw
        if (mode !== 2) {
            raw = this.ori_info?.[id] || this.sp_info?.[id]
        }
        if (!raw && (mode === 1 || mode === 2)) {
            raw = Config.getUserCfg('otherinfo')?.[id]
        }
        return raw ? new SongsInfo(raw) : undefined
    }

    /**
     * 
     * @param {boolean} [original=false] 仅使用原版
     * @returns {Record<idString, SongsInfo>} 所有曲目信息对象
     */
    all_info(original = false) {
        const mode = original ? 0 : Config.getUserCfg('config', 'otherinfo')
        const cacheKey = `${original ? 1 : 0}:${mode}`
        const cached = this._allInfoCache.get(cacheKey)
        if (cached) return cached

        /** @type {Record<idString, any>} */
        let result = {}
        switch (mode) {
            case 0: {
                result = Object.assign({}, this.ori_info, this.sp_info)
                break
            }
            case 1: {
                result = Object.assign({}, this.ori_info, this.sp_info, Config.getUserCfg('otherinfo') || {})
                break
            }
            case 2: {
                // otherinfo 本身来自 Config 缓存，直接引用即可
                result = Config.getUserCfg('otherinfo') || {}
                break
            }
            default: {
                result = Object.assign({}, this.ori_info, this.sp_info)
                break
            }
        }

        this._allInfoCache.set(cacheKey, result)
        return result
    }

    /**
    * 根据参数模糊匹配返回原曲名称
    * @param {string} mic 别名
    * @param {number} [Distance=0.85] 阈值 猜词0.95
    * @param {boolean} [original=false] 仅使用原版
    * @returns {idString[]} 原曲id数组，按照匹配程度降序
    */
    fuzzysongsnick(mic, Distance = 0.85, original = false) {
        /**为空返回空 */
        if (!mic) return []
        /**
         * 按照匹配程度排序
         * @type {{id: idString, dis: number}[]}
         */
        let result = []

        const usernick = Config.getUserCfg('nickconfig')
        const allinfo = this.all_info(original)

        for (let std in this.songnick) {
            let dis = fCompute.jaroWinklerDistance(mic, std)
            if (dis >= Distance) {
                for (let i in this.songnick[std]) {
                    result.push({ id: this.songnick[std][i], dis: dis })
                }
            }
        }

        const ids = fCompute.objectKeys(allinfo);
        for (let std of ids) {
            let dis = fCompute.jaroWinklerDistance(mic, std)
            if (dis >= Distance) {
                result.push({ id: allinfo[std].id, dis: dis })
            }
            if (!allinfo[std]?.id) continue
            dis = fCompute.jaroWinklerDistance(mic, allinfo[std].song)
            if (dis >= Distance) {
                result.push({ id: allinfo[std].id, dis: dis })
            }
        }



        for (let std in usernick) {
            let dis = fCompute.jaroWinklerDistance(mic, std)
            if (dis >= Distance) {
                usernick[std].forEach((id, i) => {
                    if (!this.hasInfo(id, original)) return; //过滤无效id（避免高成本 info() 分配）
                    result.push({ id: usernick[std][i], dis: dis })
                })
            }
        }


        result = result.sort((a, b) => b.dis - a.dis)

        /**
         * @type {idString[]}
         */
        const all = []
        const seen = new Set()
        for (let i of result) {
            // 去重（避免 O(n^2) 的 includes）
            if (seen.has(i.id)) continue
            /**如果有完全匹配的曲目则放弃剩下的 */
            if (result[0]?.dis == 1 && i.dis < 1) break
            seen.add(i.id)
            all.push(i.id)
        }

        return all
    }

    /**
     * 设置别名
     * @param {string} mic 原名
     * @param {string} nick 别名
     */
    async setnick(mic, nick) {
        if (!Config.getUserCfg('nickconfig', mic)) {
            Config.modify('nickconfig', nick, [mic])
        } else {
            Config.modifyarr('nickconfig', nick, mic, 'add')
        }
    }


    /**
     * 获取曲绘，返回地址，曲目id
     * @param {idString} id 曲目id，带.0
     * @param {'common'|'blur'|'low'} [kind='common'] 清晰度
     * @return {string} 网址或文件地址
    */
    getill(id, kind = 'common') {
        const mode = Config.getUserCfg('config', 'otherinfo')
        const cacheKey = `${mode}:${id}:${kind}`
        const cached = this._illCache.get(cacheKey)
        if (cached) return cached

        const songsinfo = this.all_info()[id]
        let ans = songsinfo?.illustration
        if (ans && !URL_REG.test(ans)) {
            ans = path.join(ortherIllPath, ans)
        } else if (this.ori_info?.[id] || this.sp_info?.[id]) {
            if (this.ori_info?.[id]) {
                if (fs.existsSync(path.join(originalIllPath, id.replace(/.0$/, '.png')))) {
                    ans = path.join(originalIllPath, id.replace(/.0$/, '.png'))
                } else if (fs.existsSync(path.join(originalIllPath, "ill", id.replace(/.0$/, '.png')))) {
                    if (kind == 'common') {
                        ans = path.join(originalIllPath, "ill", id.replace(/.0$/, '.png'))
                    } else if (kind == 'blur') {
                        ans = path.join(originalIllPath, "illBlur", id.replace(/.0$/, '.png'))
                    } else if (kind == 'low') {
                        ans = path.join(originalIllPath, "illLow", id.replace(/.0$/, '.png'))
                    }
                } else {
                    if (kind == 'common') {
                        ans = `${Config.getUserCfg('config', 'onLinePhiIllUrl')}/ill/${id.replace(/.0$/, '.png')}`
                    } else if (kind == 'blur') {
                        ans = `${Config.getUserCfg('config', 'onLinePhiIllUrl')}/illBlur/${id.replace(/.0$/, '.png')}`
                    } else if (kind == 'low') {
                        ans = `${Config.getUserCfg('config', 'onLinePhiIllUrl')}/illLow/${id.replace(/.0$/, '.png')}`
                    }
                }
            } else {
                if (fs.existsSync(path.join(originalIllPath, "SP", songsinfo.song + '.png'))) {
                    ans = path.join(originalIllPath, "SP", songsinfo.song + '.png')
                } else {
                    ans = `${Config.getUserCfg('config', 'onLinePhiIllUrl')}/SP/${songsinfo.song}.png`
                }
            }
        } else if (ans) {
            ans = path.join(ortherIllPath, ans)
        }
        if (!ans) {
            logger.warn(id, '背景不存在')
            ans = path.join(imgPath, 'phigros.png')
        }
        this._illCache.set(cacheKey, ans)
        return ans
    }

    /**
     * 
     * @param {idString} songId 
     * @param {levelKind} dif 
     */
    getChartImg(songId, dif) {
        const id = songId.replace(/.0$/, '');
        const cacheKey = `${dif}:${id}`
        const cached = this._chartImgCache.get(cacheKey)
        if (cached) return cached
        const ans = fs.existsSync(path.join(originalIllPath, "chartimg", dif, `${id}.png`))
            ? path.join(originalIllPath, "chartimg", dif, `${id}.png`)
            : `${Config.getUserCfg('config', 'onLinePhiIllUrl')}/chartimg/${dif}/${id}.png`
        this._chartImgCache.set(cacheKey, ans)
        return ans
    }

    /**
     * 返回定数表图片 url
     * @param {number} dif 难度
     */
    getTableImg(dif) {
        const cacheKey = `${dif}`
        const cached = this._tableImgCache.get(cacheKey)
        if (cached) return cached
        const ans = fs.existsSync(path.join(originalIllPath, "table", `${dif}.png`))
            ? path.join(originalIllPath, "table", `${dif}.png`)
            : `${Config.getUserCfg('config', 'onLinePhiIllUrl')}/table/${dif}.png`
        this._tableImgCache.set(cacheKey, ans)
        return ans
    }

    /**
     * 返回章节封面 url
     * @param {string} name 标准章节名
     */
    getChapIll(name) {
        const cacheKey = `${name}`
        const cached = this._chapIllCache.get(cacheKey)
        if (cached) return cached
        const ans = fs.existsSync(path.join(originalIllPath, "chap", `${name}.png`))
            ? path.join(originalIllPath, "chap", `${name}.png`)
            : `${Config.getUserCfg('config', 'onLinePhiIllUrl')}/chap/${name}.png`
        this._chapIllCache.set(cacheKey, ans)
        return ans
    }

    /**
     * 通过id获得头像文件名称
     * @param {string} id 
     * @returns file name
     */
    idgetavatar(id) {
        if (this.avatarid?.includes(id)) {
            return id
        } else {
            return 'Introduction'
        }
    }

    /**
     * 根据曲目id获取原名
     * @param {idString} id 曲目id
     * @returns {songString | undefined} 原名
     */
    idgetsong(id) {
        return this.songsid?.[id]
    }

    /**
     * 通过原曲曲目获取曲目id
     * @param {songString} song 原曲曲名
     * @returns {idString | undefined} 曲目id
     */
    SongGetId(song) {
        return this.idssong?.[song]
    }

    /**
     * 获取角色介绍背景曲绘
     * @param {string} save_background 
     * @returns 
     */
    getBackground(save_background) {
        try {
            switch (save_background) {
                case 'Another Me ': {
                    save_background = 'Another Me (KALPA)'
                    break
                }
                case 'Another Me': {
                    save_background = 'Another Me (Rising Sun Traxx)'
                    break
                }
                case 'Re_Nascence (Psystyle Ver.) ': {
                    save_background = 'Re_Nascence (Psystyle Ver.)'
                    break
                }
                case 'Energy Synergy Matrix': {
                    save_background = 'ENERGY SYNERGY MATRIX'
                    break
                }
                case 'Le temps perdu-': {
                    save_background = 'Le temps perdu'
                    break
                }
                default: {
                    break
                }
            }
            // @ts-ignore
            return this.getill(this.SongGetId(save_background) || save_background)
        } catch (err) {
            logger.error(`获取背景曲绘错误`, err)
            return 'Introduction';
        }
    }

}()

/**
 * 
 * @param {idStringWithout0} idWithout0 
 * @returns {idString}
 */
function idWithout0ToIdWith0(idWithout0) {
    return /** @type {idString} */(idWithout0 + '.0')
}
