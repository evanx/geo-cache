const crypto = require('crypto');
const fetch = require('node-fetch');
const h = require('render-html-rpf');
const lodash = require('lodash');
const multiExecAsync = require('multi-exec-async');

module.exports = async appx => {
    const {config, logger, client, api} = appx;
    logger.info('config', {config});
    api.get('/stats', async ctx => {
        ctx.redirect('/metrics');
    });
    api.get('/metrics', async ctx => {
        const [getCount, setCount] = await multiExecAsync(client, multi => {
            multi.hgetall([config.redisNamespace, 'get:path:count:h'].join(':'));
            multi.hgetall([config.redisNamespace, 'set:path:count:h'].join(':'));
        });
        const metrics = {getCount, setCount};
        if (!/(Mobile)/.test(ctx.get('user-agent'))) {
            ctx.body = h.page({
                title: 'gcache',
                heading: 'Metrics',
                content: [{
                    name: 'pre',
                    content: JSON.stringify(metrics, null, 2)}
                ],
                footerLink: 'https://github.com/evanx/geo-cache'
            });
        } else {
            ctx.body = metrics;
        }
    });
    api.get('/maps/api/*', async ctx => {
        const path = ctx.params[0];
        const url = 'https://maps.googleapis.com/maps/api/' + path;
        const query = Object.assign({}, ctx.query);
        const authQuery = Object.assign({}, {key: config.apiKey}, ctx.query);
        if (!authQuery.key) {
            ctx.statusCode = 401;
            const statusText = 'Unauthorized';
            ctx.body = statusText + '\n';
            return;
        }
        delete query.key;
        logger.debug('query', {url, query});
        const sha = crypto.createHash('sha1').update(
            [url, JSON.stringify(query)].join('#')
        ).digest('hex');
        const cacheKey = [config.redisNamespace, sha, 'json'].join(':');
        const [cachedContent] = await multiExecAsync(client, multi => {
            multi.get(cacheKey);
            multi.expire(cacheKey, config.expireSeconds);
            multi.hincrby([config.redisNamespace, 'get:path:count:h'].join(':'), path, 1);
        });
        if (cachedContent) {
            logger.debug('hit', {url, sha, cacheKey});
            const parsedContent = JSON.parse(cachedContent);
            if (parsedContent.status !== 'OK' && parsedContent.status !== 'ZERO_RESULTS') {
            } else {
                logger.warn('hit', {url, sha, cacheKey, parsedContent});
                ctx.set('Content-Type', 'application/json');
                ctx.body = JSON.stringify(parsedContent, null, 2) + '\n';
                return;
            }
        }
        const urlQuery = url + '?' + Object.keys(authQuery)
        .map(key => [key, encodeURIComponent(authQuery[key])].join('='))
        .join('&');
        const res = await fetch(urlQuery);
        if (res.status !== 200) {
            logger.debug('statusCode', url, res.status, res.statusText, query);
            ctx.statusCode = res.status;
            ctx.body = res.statusText + '\n';
            return;
        }
        const fetchedContent = await res.json();
        const formattedContent = JSON.stringify(fetchedContent, null, 2) + '\n';
        ctx.set('Content-Type', 'application/json');
        ctx.body = formattedContent;
        if (fetchedContent.status !== 'OK' && fetchedContent.status !== 'ZERO_RESULTS') {
            logger.debug('status', fetchContent.status, url);
        } else {
            await multiExecAsync(client, multi => {
                multi.setex(cacheKey, config.expireSeconds, formattedContent);
                multi.hincrby([config.redisNamespace, 'set:path:count:h'].join(':'), path, 1);
            });
        }
    });
}
