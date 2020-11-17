const express = require('express');
const csrf = require('csurf');
const _ = require('underscore');
const permission = require('../lib/permission');

/* GET users listing. */
async function list(req, res, next){
    res.locals.breadcrumbs = {
        path: [
            { url: '/', name: 'Home'},
        ],
        current: 'Players'
    };
    try {
        const players = (await req.models.user.list()).filter(user => {
            return user.is_player;
        });
        res.locals.users = await Promise.all(
            players.map( async user => {
                user.player = await req.models.player.getByUserId(user.id);
                user.player.gamestate = await req.models.gamestate.get(user.player.gamestate_id);
                user.player.prev_gamestate = await req.models.gamestate.get(user.player.prev_gamestate_id);
                return user;
            })
        );
        res.locals.runs = _.indexBy(await req.models.run.list(), 'id');
        res.locals.player_groups = _.indexBy(await req.models.player_group.list(), 'id');

        res.render('player/list', { pageTitle: 'Players' });
    } catch (err){
        next(err);
    }
}

const router = express.Router();

router.use(permission('gm'));
router.use(function(req, res, next){
    res.locals.siteSection='gm';
    next();
});

router.get('/', list);

module.exports = router;