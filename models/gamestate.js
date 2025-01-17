'use strict';
const async = require('async');
const _ = require('underscore');
const database = require('../lib/database');
const validator = require('validator');
const cache = require('../lib/cache');

const models = {
    code: require('./code')
};

const tableFields = ['name', 'description', 'image_id', 'start', 'finish', 'special', 'map', 'template', 'chat', 'show_count', 'show_name'];


exports.get = async function(id){
    let gamestate = await cache.check('gamestate', id);
    if (gamestate) { return gamestate; }
    const query = 'select * from gamestates where id = $1';
    const result = await database.query(query, [id]);
    if (result.rows.length){
        gamestate = await fillCodes(result.rows[0]);
        await cache.store('gamestate', id, gamestate);
        return gamestate;
    }
    return;
};

exports.getStart = async function(){
    const query = 'select * from gamestates where start = true limit 1';
    const result = await database.query(query);
    if (result.rows.length){
        return fillCodes(result.rows[0]);
    }
    return;
};

exports.list = async function(){
    let gamestates = await cache.check('gamestate', 'list');

    if (gamestates) { return gamestates; }
    const query = 'select * from gamestates order by name';
    const result = await database.query(query);
    gamestates = await async.map(result.rows, fillCodes);
    await cache.store('gamestate', 'list', gamestates);
    return gamestates;
};

exports.listSpecial = async function(){
    const query = `select * from gamestates where start = true or special = true or finish = true
        order by start desc nulls last, finish asc nulls first, name`;
    const result = await database.query(query);
    return async.map(result.rows, fillCodes);
};

exports.listForChat = async function(){
    let gamestates = await cache.check('gamestate', 'chatlist');
    if (gamestates) { return gamestates; }
    const query = 'select * from gamestates where template = false and start = false and finish = false and chat = true order by name';
    const result = await database.query(query);
    gamestates = result.rows;
    await cache.store('gamestate', 'chatlist', gamestates);
    return gamestates;
};

exports.create = async function(data){
    if (! validate(data)){
        throw new Error('Invalid Data');
    }
    const queryFields = [];
    const queryData = [];
    const queryValues = [];
    for (const field of tableFields){
        if (_.has(data, field)){
            queryFields.push(field);
            queryValues.push('$' + queryFields.length);
            queryData.push(data[field]);
        }
    }

    let query = 'insert into gamestates (';
    query += queryFields.join (', ');
    query += ') values (';
    query += queryValues.join (', ');
    query += ') returning id';

    const result = await database.query(query, queryData);
    const id = result.rows[0].id;
    if (_.has(data, 'codes')){
        await saveCodes(id, data.codes);
    }
    return id;
};

exports.update = async function(id, data){
    if (! validate(data)){
        throw new Error('Invalid Data');
    }
    const queryUpdates = [];
    const queryData = [id];
    for (const field of tableFields){
        if (_.has(data, field)){
            queryUpdates.push(field + ' = $' + (queryUpdates.length+2));
            queryData.push(data[field]);
        }
    }

    let query = 'update gamestates set ';
    query += queryUpdates.join(', ');
    query += ' where id = $1';

    await database.query(query, queryData);
    await cache.invalidate('gamestate', id);
    await cache.invalidate('gamestate', 'list');
    await cache.invalidate('gamestate', 'chatlist');
    await cache.invalidate('gamestaterecord', id);
    if (_.has(data, 'codes')){
        await saveCodes(id, data.codes);
    }
};

exports.delete = async function(id){
    const query = 'delete from gamestates where id = $1';
    await database.query(query, [id]);
    await cache.invalidate('gamestate', id);
    await cache.invalidate('gamestate', 'list');
    await cache.invalidate('gamestate', 'chatlist');
    await cache.invalidate('gamestaterecord', id);
};

async function fillCodes(gamestate){
    const query = 'select * from gamestate_codes where gamestate_id = $1';
    const result = await database.query(query, [gamestate.id]);
    gamestate.codes = await async.map(result.rows, async gamestateLink => {
        return models.code.get(gamestateLink.code_id);
    });
    return gamestate;
}

async function saveCodes(gamestate_id, codes){
    const currentQuery  = 'select * from gamestate_codes where gamestate_id = $1';
    const insertQuery = 'insert into gamestate_codes (gamestate_id, code_id) values ($1, $2)';
    const deleteQuery = 'delete from gamestate_codes where gamestate_id = $1 and code_id = $2';
    const current = await database.query(currentQuery, [gamestate_id]);

    const  newCodes = [];
    for (const code of codes){
        if (_.isObject(code)){
            newCodes.push(Number(code.id));
        } else {
            newCodes.push(Number(code));
        }
    }

    for (const codeId of newCodes){
        if(!_.findWhere(current.rows, {code_id: Number(codeId)})){
            await database.query(insertQuery, [gamestate_id, codeId]);
        }
    }

    for (const code of current.rows){
        if(_.indexOf(newCodes, code.code_id) === -1){
            await database.query(deleteQuery, [gamestate_id, code.code_id]);
        }
    }
}

function validate(data){
    if (! validator.isLength(data.name, 2, 80)){
        return false;
    }

    return true;
}
