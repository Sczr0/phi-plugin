import plugin from '../../../lib/plugins/plugin.js'
import Save from '../model/class/Save.js'
import fCompute from '../model/fCompute.js'
import getInfo from '../model/getInfo.js'
import getRksRank from '../model/getRksRank.js'
import getSave from '../model/getSave.js'
import send from '../model/send.js'
import atlas from '../model/picmodle.js'
import Config from '../components/Config.js'
import getNotes from '../model/getNotes.js'

export class phiRankList extends plugin {

    constructor() {
        super({
            name: 'phi-rankList',
            event: 'message',
            priority: 1000,
            dsc: 'phigros rks 排行榜',
            rule: [
                {
                    reg: `^[#/](${Config.getUserCfg('config', 'cmdhead')})(\\s*)(排行榜|ranklist).*$`,
                    fnc: 'rankList'
                }
            ]

        })
    }

    async rankList(e) {
        let save = await send.getsave_result(e)
        if (!save) {
            return true
        }
        let sessionToken = save.getSessionToken()
        let rankNum = await getRksRank.getUserRank(sessionToken)
        let plugin_data = await getNotes.getPluginData(e.user_id)
        let data = {
            totDataNum: 0,
            BotNick: Bot.nickname,
            users: [],
            background: getInfo.getill(getInfo.illlist[Number((Math.random() * (getInfo.illlist.length - 1)).toFixed(0))], 'blur'),
            theme: plugin_data?.plugin_data?.theme || 'star',
        }

        data.totDataNum = (await getRksRank.getAllRank()).length
        let list = await getRksRank.getRankUser(0, 10)
        for (let i = 0; i < 3; i++) {
            data.users.push(await makeLargeLine(await getSave.getSaveBySessionToken(list[i])))
            data.users[i].index = i
        }

        if (rankNum <= 3) {
            data.users[rankNum].me = true

            for (let i = 3; i < 10; i++) {
                data.users.push(await makeSmallLine(await getSave.getSaveBySessionToken(list[i])))
                data.users[i].index = i
            }
        } else if (rankNum <= 10) {
            for (let i = 3; i < rankNum; i++) {
                data.users.push(await makeSmallLine(await getSave.getSaveBySessionToken(list[i])))
                data.users[i].index = i
            }

            data.users.push(await makeLargeLine(await getSave.getSaveBySessionToken(list[rankNum])))
            data.users[rankNum].me = true
            data.users[rankNum].index = rankNum

            for (let i = rankNum + 1; i < 10; i++) {
                data.users.push(await makeSmallLine(await getSave.getSaveBySessionToken(list[i])))
                data.users[i].index = i
            }
        } else {
            for (let i = 3; i < 5; i++) {
                data.users.push(await makeSmallLine(await getSave.getSaveBySessionToken(list[i])))
                data.users[i].index = i
            }

            list = await getRksRank.getRankUser(rankNum - 3, rankNum + 4)
            for (let i = 0; i < 3; ++i) {
                data.users.push(await makeSmallLine(await getSave.getSaveBySessionToken(list[i])))
                data.users[5 + i].index = rankNum - 3 + i
            }

            data.users.push(await makeLargeLine(await getSave.getSaveBySessionToken(list[3])))
            data.users[8].me = true
            data.users[8].index = rankNum

            for (let i = 4; i < list.length; ++i) {
                data.users.push(await makeSmallLine(await getSave.getSaveBySessionToken(list[i])))
                data.users[5 + i].index = rankNum
            }
        }
        send.send_with_At(e, await atlas.common(e, 'rankingList', data))
    }
}

/**
 * 创建一个详细对象
 * @param {Save} save 
 */
async function makeLargeLine(save) {
    // console.info(save)
    let user = {
        backgroundurl: null,
        avatar: getInfo.idgetavatar(save.saveInfo.summary.avatar) || 'Introduction',
        playerId: save.saveInfo.PlayerId,
        rks: save.saveInfo.summary.rankingScore,
        ChallengeMode: (save.saveInfo.summary.challengeModeRank - (save.saveInfo.summary.challengeModeRank % 100)) / 100,
        ChallengeModeRank: save.saveInfo.summary.challengeModeRank % 100,
        created: fCompute.formatDate(save.saveInfo.createdAt),
        updated: fCompute.formatDate(save.saveInfo.gameFile.updatedAt),
        selfIntro: save?.gameuser?.selfIntro,
        b19: []
    }
    user.backgroundurl = await fCompute.getBackground(save?.gameuser?.background)
    let b19 = await save.getB19(19)
    user.b19.push({ difficulty: b19.phi.difficulty, acc: b19.phi.acc, Rating: b19.phi.Rating })
    for (let i = 0; i < 19; i++) {
        user.b19.push({ difficulty: b19.b19_list[i].difficulty, acc: b19.b19_list[i].acc, Rating: b19.b19_list[i].Rating })
    }
    return user
}

/**
 * 创建一个简略对象
 * @param {Save} save 
 */
async function makeSmallLine(save) {
    // console.info(save)
    return {
        avatar: getInfo.idgetavatar(save.saveInfo.summary.avatar) || 'Introduction',
        playerId: save.saveInfo.PlayerId,
        rks: save.saveInfo.summary.rankingScore,
        ChallengeMode: (save.saveInfo.summary.challengeModeRank - (save.saveInfo.summary.challengeModeRank % 100)) / 100,
        ChallengeModeRank: save.saveInfo.summary.challengeModeRank % 100,
        updated: fCompute.formatDate(save.saveInfo.gameFile.updatedAt),
    }
}