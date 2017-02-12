const crypto = require('crypto');
const fetch = require('node-fetch');
const multiExecAsync = require('multi-exec-async');

module.exports = async appx => {
    const {config, logger, client, api} = appx;
    logger.info('config', {config});
    api.get('/maps/api/*', async ctx => {
        const path = ctx.params[0];
        const url = 'https://maps.googleapis.com/maps/api/' + path;
        const sha = crypto.createHash('sha1').update(ctx.request.url).digest('hex');
        const cacheKey = [config.redisNamespace, sha, 'json'].join(':');
        const [cachedContent] = await multiExecAsync(client, multi => {
            multi.get(cacheKey);
            multi.expire(cacheKey, config.expireSeconds);
        });
        if (cachedContent) {
            logger.debug('hit', {url, sha, cacheKey});
            const parsedContent = JSON.parse(cachedContent);
            if (parsedContent.status !== 'OK') {
            } else {
                logger.warn('hit', {url, sha, cacheKey, parsedContent});
                ctx.set('Content-Type', 'application/json');
                ctx.body = JSON.stringify(parsedContent, null, 2) + '\n';
                return;
            }
        }
        const query = Object.assign({}, {key: config.apiKey}, ctx.query);
        logger.debug('query', {url, query});
        if (!query.key) {
            ctx.statusCode = 401;
            const statusText = 'Unauthorized';
            ctx.body = statusText + '\n';
            return;
        }
        const urlQuery = url + '?' + Object.keys(query)
        .map(key => [key, encodeURIComponent(query[key])].join('='))
        .join('&');
        const res = await fetch(urlQuery);
        if (res.status !== 200) {
            logger.debug('statusCode', url, res.status, res.statusText, query);
            ctx.statusCode = res.status;
            ctx.body = res.statusText + '\n';
            return;
        }
        const fetchedContent = await res.json();
        const formattedContent = JSON.stringify(fetched, null, 2) + '\n';
        ctx.set('Content-Type', 'application/json');
        ctx.body = formattedContent;
        if (fetchContent.status !== 'OK') {
            logger.debug('status', fetchContent.status, url);
        } else {
            await multiExecAsync(client, multi => {
                multi.setex(cacheKey, config.expireSeconds, formattedContent);
                if (config.debug) {
                    const hashesKey = [config.redisNamespace, 'url:h'].join(':');
                    multi.hset(hashesKey, sha, ctx.request.url);
                    multi.expire(hashesKey, config.expireSeconds);
                }
            });
        }
    });
}
