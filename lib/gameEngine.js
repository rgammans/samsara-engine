'use strict';
const _ = require('underscore');
const async = require('async');
const config = require('config');
const models = require('./models');
const script = require('./script');
const cache = require('./cache');
const jitsi = require('./jitsi');

exports.getGameState = async function getGameState(userId){
    if (!userId) { console.trace('no');}
    const state = {
        player: {},
        next: {},
        prev: {},
        current: {},
        transitioning: false
    };
    const user = await models.user.get(userId);
    if (!user) {
        throw new Error(`Invalid userId ${userId}`);
    }
    if (user.type !== 'player'){
        return {
            chatSidebar:user.type !== 'none',
            chat:true,
            chatExpanded:false
        };
    }
    state.player = await models.player.getByUserId(userId);
    state.run = await models.run.get(state.player.run_id);
    state.next = await getGameStateRecord(state.player.gamestate_id);

    if (state.player.prev_gamestate_id){
        state.prev = await getGameStateRecord(state.player.prev_gamestate_id);
    }
    if(new Date().getTime() < new Date(state.player.statetime).getTime()){
        state.current = state.prev;
        state.transitioning = true;
    } else {
        state.current = state.next;
    }
    return state;
};

exports.getTransitionsFrom = async function getTransitionsFrom(gamestate){
    const transitions = [];
    if (gamestate.image_id){
        for (const area of gamestate.map){
            for (const action of area.actions){
                if (action.type === 'transition'){
                    const doc = {
                        name: area.name,
                        areaId: area.uuid,
                        to_state_id: Number(action.to_state_id),
                        from_state_id: gamestate.id,
                        delay: Number(action.delay),
                        group_id: Number(action.group_id),
                        type: 'map'
                    };
                    if (action.group_id){
                        const group = await models.group.get(action.group_id);
                        doc.group_name = group.name;
                    }
                    transitions.push(doc);
                }
            }
        }
    }

    const records = await models.transition.find({from_state_id:gamestate.id});

    for (const transition of records){
        transition.type = 'gamestate';
        transitions.push(transition);
    }
    return transitions;
};

exports.getTransitionsTo = async function getTransitionsTo(gamestateId){
    const gamestates = (await models.gamestate.list()).filter(state => {return !state.template;});
    let transitions = [];
    for (const gamestate of gamestates){
        const stateTransitions = await exports.getTransitionsFrom(gamestate);
        transitions = transitions.concat(stateTransitions.filter(transition => {
            return transition.to_state_id === gamestateId;
        }));
    }
    return transitions;
};

async function getGameStateRecord(id){
    const gamestate = await models.gamestate.get(id);
    if (!gamestate){ return; }

    gamestate.transitions  = await exports.getTransitionsFrom(gamestate);

    if(gamestate.image_id){
        gamestate.image = await models.image.get(gamestate.image_id);
    }

    return gamestate;
}
exports.getGameStateRecord = getGameStateRecord;

exports.openCode = async function openCode(code, userId){
    const codeRecord = await models.code.getByCode(code);
    const gamestate = await exports.getGameState(userId);
    if (!codeRecord) { throw new Error('Invalid Code'); }
    if (!_.findWhere(gamestate.current.codes, {id: codeRecord.id})){
        return [];
    }

    const actions = await getActions(codeRecord.actions, userId);
    await exports.updateTriggers(userId);
    return actions;
};

exports.openArea = async function openArea(areaUuid, userId){
    const gamestate = await exports.getGameState(userId);
    const state = gamestate.current;
    let actions = [];
    if (state.image_id){
        const area = _.findWhere(state.map, {uuid: areaUuid});
        if(area){
            const user = await models.user.get(userId);

            if (area.condition && ! await script.runCheck(area.condition, user.player)){
                return actions;
            }
            if (area.group_id && !_.findWhere(user.player.groups, {id: area.group_id})){
                return actions;
            }
            actions = await getActions(area.actions, userId);
        }
    }
    await exports.updateTriggers(userId);
    return actions;
};

exports.runTrigger = async function runTrigger(triggerId, userId){
    if (! await checkTrigger(triggerId, userId)){
        return [];
    }
    const trigger = await models.trigger.get(triggerId);
    const actions = await getActions(trigger.actions, userId);
    await exports.updateTriggers(userId);
    return actions;
};


exports.updateTriggers = async function updateTriggers(userId) {
    const user = await models.user.get(userId);
    if (user.type !== 'player'){
        return false;
    }
    let triggers = await cache.check('trigger', 'list');
    if (!triggers) {
        triggers = (await models.trigger.list()).filter( trigger => { return trigger.player; } );
        await cache.store('trigger', 'list', triggers);
    }
    const filteredTriggers = await async.filterLimit(triggers, 5, async trigger => {
        return await checkTrigger(trigger.id, userId);
    });

    return await models.player.saveTriggers(user.player.id, filteredTriggers);
};

exports.updateAllTriggers = async function updateAllTriggers(){
    const users = await models.user.list();
    await async.eachLimit(users, 5, async user => {
        return exports.updateTriggers(user.id);
    });
};

async function checkTrigger(triggerId, userId){
    const trigger = await models.trigger.get(triggerId);
    const user = await models.user.get(userId);
    if (user.type !== 'player'){
        return false;
    }
    if (trigger.condition && ! await script.runCheck(trigger.condition, user.player)){
        return false;
    }
    if (trigger.group_id && !_.findWhere(user.player.groups, {id: trigger.group_id})){
        return false;
    }
    return true;
}

async function getActions(actions, userId){
    const filteredActions = [];
    let stateChanged = false;
    if (!actions) {
        return filteredActions;
    }
    for (const action of actions){
        const gamestate =  await exports.getGameState(userId);
        if (action.condition){
            if (! await script.runCheck(action.condition, gamestate.player)){
                continue;
            }
        }
        if (action.group_id && !_.findWhere(gamestate.player.groups, {id: action.group_id})){
            continue;
        }
        switch(action.type){
            case 'link': {
                let link = await models.link.get(action.link_id);
                if (!link) {
                    continue;
                }

                if (!link.active){
                    continue;
                }

                if (link.url === 'stub'){
                    if(gamestate.run.show_stubs){
                        filteredActions.push({action:'load', url:'/stub/' + link.id, stub:true});
                    }
                } else {
                    filteredActions.push({action: 'load', url: link.url});
                }

                break;
            }
            case 'meeting': {
                let meeting = await models.meeting.get(action.meeting_id);
                if (!meeting) {
                    continue;
                }

                if (!meeting.active){
                    continue;
                }

                if (!await jitsi.active()){
                    continue;
                }

                const doc = {
                    action: 'video',
                    domain: config.get('jitsi.server'),
                    meetingName: meeting.meeting_id,
                };
                if (meeting.public){
                    doc.jwt = jitsi.token(meeting.meeting_id);
                    doc.subject = meeting.name;
                }

                filteredActions.push(doc);

                break;
            }

            case 'closemeeting':
                filteredActions.push({action: 'closevideo'});
                break;

            case 'text':{
                const doc = {
                    action:'display',
                    content: action.content?action.content:'',
                    duration:action.duration?action.duration:0,
                    location: action.location,
                    name: ''
                };

                if (_.has(action, 'document_id')){
                    const text = await models.document.get(action.document_id);
                    if(action.location === 'popout'){
                        doc.action = 'load';
                        doc.url = `/document/code/${text.code}`;

                    } else {
                        doc.content = text.content;
                        doc.name = text.name;
                    }
                }

                filteredActions.push(doc);
                break;
            }

            case 'image': {
                const image = await models.image.get(action.image_id);
                filteredActions.push({action:'image', image_url:image.url, name:image.display_name, content: image.description});
                break;
            }

            case 'transition':
                if (!stateChanged){
                    if (await exports.changeState(userId, action.to_state_id, action.delay)){
                        stateChanged = true;
                    }
                }
                break;

            case 'script':{
                let result = null;
                try{
                    result = await script.runAction(action.script, gamestate.player);
                    if (!stateChanged && result && result.gamestate_id){
                        await exports.changeState(userId, result.to_state_id, result.delay);
                        stateChanged = true;
                    }
                    if (result.runUpdated){
                        filteredActions.push({action:'runupdate', run_id:gamestate.run.id});
                        await exports.updateAllTriggers();
                    }
                    if (result.playerUpdated){
                        filteredActions.push({action:'playerupdate', run_id:gamestate.run.id});
                    }
                    if (result.actions){
                        for (const item of result.actions){
                            filteredActions.push(item);
                        }
                    }
                } catch (err) {
                    console.error(err);
                }
                break;
            }
        }
    }
    return filteredActions;
}

// Update a player's state
exports.changeState = async function changeState(userId, newStateId, delay, force){
    const player = await models.player.getByUserId(userId);
    const changeTime = new Date();
    changeTime.setSeconds(changeTime.getSeconds() + delay);
    let stateChanged = false;
    if (force || player.gamestate_id !== newStateId){
        player.prev_gamestate_id = player.gamestate_id;
        player.gamestate_id = newStateId;
        player.statetime = changeTime;
        stateChanged = true;
    } else {
        if (player.statetime > changeTime){
            player.statetime = changeTime;
        }
    }
    await models.player.update(player.id, player);
    return stateChanged;
};

exports.nextState = async function nextState(userId){
    const gamestate = await exports.getGameState(userId);
    for (const transition of gamestate.current.transitions){
        // Skip Area/Map-based transitions
        if (transition.type === 'map'){
            continue;
        }
        // Skip Code-based transitions
        if (transition.link_id){
            continue;
        }
        // Skip transitions for other groups
        if (transition.group_id && !_.findWhere(gamestate.player.groups, {id: transition.group_id})){
            continue;
        }
        await exports.changeState(userId, transition.to_state_id, transition.delay, true);
        return true;
    }
    return false;
};

exports.getGamestateCounts = async function getGamestateCounts(runId){
    if (!runId){
        runId = (await models.run.getCurrent()).id;
    }
    const gamestates = (await models.gamestate.list()).filter(gamestate => {
        return gamestate.show_count;
    });
    const players = await models.player.find({run_id: runId});
    const states = {};
    for (const player of players){
        const gamestate = _.findWhere(gamestates, {id: player.gamestate_id});
        if (gamestate){
            if (!_.has(states, player.gamestate_id)){
                states[player.gamestate_id.toString()] = 0;
            }
            states[player.gamestate_id.toString()]++;
        }
    }
    return states;
};

exports.getMeetingCounts = async function getMeetingCounts(userId, gamestateId){
    const player = await models.player.getByUserId(userId);
    const run = await models.run.get(player.run_id);
    const meetings = await models.meeting.find({gamestate_id: gamestateId, show_users: true});
    let rooms = {};
    if (await jitsi.active()){
        rooms = await jitsi.rooms();
    }

    return async.map(meetings, async meeting => {
        const id = meeting.meeting_id.toLowerCase();
        const participants = await models.participant.find({meeting_id:meeting.id});

        const users = [];
        for (const participant of participants){
            const user = participant.user;
            if (user.type === 'player'){
                users.push({
                    name: user.player && user.player.character?user.player.character:user.name,
                    self: user.id === userId
                });
            }
        }

        return {
            id: meeting.id,
            name: meeting.name,
            count: _.has(rooms, id)?rooms[id]:0,
            users: users
        };
    });
};

exports.getAreaMeeting = async function getAreaMeeting(area, userId){
    const actions = area.actions.filter( action => {
        if (action.type === 'meeting' || action.type === 'script') {
            return true;
        }
        return false;
    });
    let meetingData = null;

    await async.each(actions, async (action) => {
        switch (action.type){
            case 'meeting': {
                const meeting = await models.meeting.get(action.meeting_id);
                if (meeting.show_users){
                    meetingData = meeting.id;
                }
                break;
            }
            case 'script':{
                const player = await models.player.getByUserId(userId);
                const result = await script.runAction(action.script, player);
                async.each(result.actions, async (scriptAction) => {
                    if (scriptAction.type !== 'meeting') { return; }
                    const meeting = await models.meeting.get(action.meeting_id);
                    if (meeting.show_users){
                        meetingData = meeting.id;
                    }
                });
                break;
            }
        }
    });

    return meetingData;
};

exports.getGameStatesFromMeeting = async function getGameStatesFromMeeting(meetingId){
    const gamestates = await models.gamestate.list();
    return gamestates.filter(gamestate => {
        if (gamestate.template) { return false; }
        for (const area of gamestate.map){
            for (const action of area.actions){
                if (action.type === 'meeting' && action.meeting_id === meetingId){
                    return true;
                }
                if (action.type === 'script'){
                    //eslint-disable-next-line
                    const re = new RegExp(`meeting(\s*${meetingId}\s*)`);
                    return action.script.match(re);
                }
            }
        }
        return false;
    });
};
