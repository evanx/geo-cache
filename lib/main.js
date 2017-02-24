const assert = require('assert');
const crypto = require('crypto');
const fetch = require('node-fetch');
const h = require('render-html-rpf');
const lodash = require('lodash');
const multiExecAsync = require('multi-exec-async');

const reduceAllProperties = (object, fn) => Object.keys(object).reduce((result, key) => {
    result[key] = fn(object[key]);
    return result;
}, {});

module.exports = async appx => {
    const {config, logger, client, api} = appx;
    logger.info({config}, process.env.NODE_ENV);
    api.get('/stats', async ctx => {
        ctx.redirect('/metrics');
    });
    api.get('/metrics', async ctx => {
        const [getCountRes, setCountRes, migrateCountRes] = await multiExecAsync(client, multi => {
            multi.hgetall([config.redisNamespace, 'metric:get:path:count:h'].join(':'));
            multi.hgetall([config.redisNamespace, 'metric:set:path:count:h'].join(':'));
            multi.hgetall([config.redisNamespace, 'metric:migrate:path:count:h'].join(':'));
        });
        const getCount = reduceAllProperties(getCountRes || {}, value => parseInt(value));
        const setCount = reduceAllProperties(setCountRes || {}, value => parseInt(value));
        const migrateCount = reduceAllProperties(migrateCountRes || {}, value => parseInt(value));
        const metrics = {getCount, setCount, migrateCount};
        if (/(Mobile)/.test(ctx.get('user-agent'))) {
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
        const query = Object.keys(ctx.query)
        .filter(key => key !== 'key')
        .reduce((query, key) => {
            query[key] = ctx.query[key];
            return query;
        }, {});
        assert(!query.key);
        const queryString = Object.keys(query).slice(0).sort().map(
            key => [key, encodeURIComponent(query[key])].join('=')
        ).join('&');
        const urlString = [url, queryString].join('?');
        const authQuery = Object.assign({}, {key: config.apiKey}, ctx.query);
        if (!authQuery.key) {
            ctx.statusCode = 401;
            const statusText = 'Unauthorized';
            ctx.body = statusText + '\n';
            return;
        }
        logger.debug({url, query, urlString});
        const sha = crypto.createHash('sha1').update(urlString).digest('hex');
        const cacheKey = [config.redisNamespace, sha, 'j'].join(':');
        if (true) {
            const migrateSha = crypto.createHash('sha1').update(
                [url, JSON.stringify(query)].join('#')
            ).digest('hex');
            const migrateKey = ['cache-geo-cache', migrateSha, 'json'].join(':');
            const [migrateContent] = await multiExecAsync(client, multi => {
                multi.get(migrateKey);
            });
            if (migrateContent) {
                await multiExecAsync(client, multi => {
                    multi.set(cacheKey, JSON.stringify(JSON.parse(migrateContent)));
                    multi.del(migrateKey);
                    multi.hincrby([config.redisNamespace, 'metric:migrate:path:count:h'].join(':'), path, 1);
                });
            }
        }
        let [cachedContent] = await multiExecAsync(client, multi => {
            multi.get(cacheKey);
            multi.expire(cacheKey, config.expireSeconds);
            multi.hincrby([config.redisNamespace, 'metric:get:path:count:h'].join(':'), path, 1);
        });
        if (cachedContent) {
            logger.debug('hit', {url, sha, cacheKey});
            const parsedContent = JSON.parse(cachedContent);
            const formattedContent = JSON.stringify(parsedContent);
            if (cachedContent !== formattedContent) {
                logger.debug('reformat', cacheKey, cachedContent);
                await multiExecAsync(client, multi => {
                    multi.set(cacheKey, formattedContent);
                });
            }
            if (lodash.includes(['OK', 'ZERO_RESULTS'], parsedContent.status)) {
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
        if (!lodash.includes(['OK', 'ZERO_RESULTS'], fetchedContent.status)) {
            logger.debug('status', fetchedContent.status, url);
        } else {
            const expireSeconds = lodash.includes(['ZERO_RESULTS'], fetchedContent.status)?
            config.shortExpireSeconds:
            config.expireSeconds;
            logger.debug('expireSeconds', expireSeconds, fetchedContent.status, url);
            await multiExecAsync(client, multi => {
                multi.setex(cacheKey, expireSeconds, JSON.stringify(fetchedContent));
                multi.hincrby([config.redisNamespace, 'metric:set:path:count:h'].join(':'), path, 1);
            });
        }
    });
}
