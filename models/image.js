'use strict';
const async = require('async');
const config = require('config');
const _ = require('underscore');
const database = require('../lib/database');
const validator = require('validator');

const models = {
};

const tableFields = ['name', 'description', 'status'];

exports.get = async function(id){
    const query = 'select * from images where id = $1';
    const result = await database.query(query, [id]);
    if (result.rows.length){
        return makeURL(result.rows[0]);
    }
    return;
};

exports.list = async function(){
    const query = 'select * from images order by name';
    const result = await database.query(query);
    return result.rows.map(makeURL);
};

exports.create = async function(data, cb){
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

    let query = 'insert into images (';
    query += queryFields.join (', ');
    query += ') values (';
    query += queryValues.join (', ');
    query += ') returning id';

    const result = await database.query(query, queryData);
    return result.rows[0].id;
};

exports.update = async function(id, data, cb){
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

    let query = 'update images set ';
    query += queryUpdates.join(', ');
    query += ' where id = $1';

    await database.query(query, queryData);
};

exports.delete = async  function(id, cb){
    const query = 'delete from images where id = $1';
    await database.query(query, [id]);
};



function validate(data){
    if (_.has(data, 'name') && ! validator.isLength(data.name, 2, 80)){
        return false;
    }
    return true;
}

function makeURL(image){
    const key = ['images', image.id, image.name].join('/');
    image.url = `https://${config.get('aws.imageBucket')}.s3.amazonaws.com/${key}`;
    return image;
}