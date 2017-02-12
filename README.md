
# geo-cache

Redis-based caching proxy for Google Maps API queries.

<img src="https://raw.githubusercontent.com/evanx/geo-cache/master/docs/readme/main2.png"/>

## Use case

We require a local proxy to cache requests to Google Maps API into Redis.

## Usage

We use the same path and query as per Google Maps API e.g.:
```
curl 'http://localhost:8851/maps/api/geocode/json' \
  -G --data-urlencode 'address=Waitrose, Witney, Oxfordshire, UK' |
  grep formatted | sed 's/^\s*//'
```
```
"formatted_address": "The Woolgate Centre, Woolgate Centre, 25 Market Square, Witney OX28 6AR, UK",  
```
where this service is running on port `8851`

## Installation

### Docker

We can build and run via Docker:
```
docker build -t geo-cache https://github.com/evanx/geo-cache.git
```
See https://github.com/evanx/geo-cache/blob/master/Dockerfile
```
FROM node:7.5.0
ADD package.json .
RUN npm install
ADD lib lib
CMD ["node", "--harmony", "lib/index.js"]
```

We might simply run with `--network=host` i.e. using our host's Redis:
```
docker run --network=host --restart unless-stopped -d \
  -e apiKey=$MAPS_API_KEY \
  -e httpPort=8851 \
  geo-cache
```
where we optionally provide our `apiKey` for the Google Maps API e.g. from the environment as `MAPS_API_KEY`

### Isolation

However it is preferrable from a security point of view to run using an isolated network and Redis container:
```
docker network create gcache
```
```
docker run --name gcache-redis --network=gcache -d redis
```
Or with persistent volume from the host:
```
docker rm -f gcache-redis
docker run --name gcache-redis -d \
  --network gcache \
  -v ~/volumes/gcache-data:/data \
  redis redis-server --appendonly yes
```

```
redisContainer=`docker ps -q -f name=gcache-redis`   
redisHost=`docker inspect \
  -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \
  $redisContainer`
echo $redisHost
```

```
docker run \
  --name gcache \
  --network=gcache \
  --restart unless-stopped -d \
  -e apiKey=$MAPS_API_KEY \
  -e httpPort=8851 \
  -e redisHost=$redisHost \
  geo-cache
```

### git clone

Alternatively you can `git clone` etc:
```
git clone https://github.com/evanx/geo-cache.git
cd geo-cache
npm install
apiKey=$MAPS_API_KEY npm start
```

## Redis keys

We scan keys:
```
redis-cli --scan --pattern 'cache-geo-cache:*:json'
```
where we find keys e.g.
```
cache-geo-cache:64bdaff72bfc67deb55326022371ffef3ace9c7b:json
```
where keys are named using the SHA of the request path and query.

We can inspect JSON content:
```
redis-cli get cache-geo-cache:64bdaff72bfc67deb55326022371ffef3ace9c7b:json | jq '.' | grep status
```
```
  "status": "OK",
```

Check the TTL:
```
redis-cli ttl cache-geo-cache:64bdaff72bfc67deb55326022371ffef3ace9c7b:json
```
```
(integer) 1814352
```

## Config spec

See `lib/spec.js` https://github.com/evanx/geo-cache/blob/master/lib/spec.js
```javascript
module.exports = {
    description: 'Redis-based caching proxy for Google Maps API queries.',
    required: {
        redisHost: {
            description: 'the Redis host',
            default: 'localhost'
        },
        redisPort: {
            description: 'the Redis port',
            default: 6379
        },
        redisPassword: {
            description: 'the Redis password',
            required: false
        },
        redisNamespace: {
            description: 'the Redis namespace',
            default: 'cache-geo-cache'
        },
        expireSeconds: {
            description: 'the TTL for the cached content',
            default: 21*24*3600
        },
        shortExpireSeconds: {
            description: 'the TTL for the cached content',
            default: 3*24*3600
        },
        httpPort: {
            description: 'the HTTP port',
            default: 8851
        },
        loggerLevel: {
            description: 'the logging level',
            default: 'info',
            example: 'debug'
        }
    }
}
```
where `shortExpireSeconds` is used to cache `ZERO_RESULTS` responses for a shorter time e.g. 3 days rather than 21 days.

## Implementation

See `lib/main.js` https://github.com/evanx/geo-cache/blob/master/lib/main.js
```javascript
module.exports = async appx => {
    const {config, logger, client, api} = appx;
    logger.info('config', {config});
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
        logger.debug({url, query});
        ...
    });
}
```
where `query` excludes the Google API `key` so that is not logged or stored.

We hash the URL and query:
```javascript        
        const sha = crypto.createHash('sha1').update(
            [url, JSON.stringify(query)].join('#')
        ).digest('hex');
        const cacheKey = [config.redisNamespace, sha, 'json'].join(':');
        const [cachedContent] = await multiExecAsync(client, multi => {
            multi.get(cacheKey);
            multi.expire(cacheKey, config.expireSeconds);
            multi.hincrby([config.redisNamespace, 'get:path:count:h'].join(':'), path, 1);
        });
```
where we reset the expiry when hit.

If not found in the Redis cache, then we fetch:
```javascript
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
```
where for the fetch request to `googleapis.com` we use the `authQuery` in order to include the `key` as sent in the original request. However, we ensure we do not store or log `authQuery` but rather `query`  i.e. from which the `key` has been deleted, as shown further above.

Naturally we put successfully fetched content into our Redis cache:
```javascript
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
                multi.setex(cacheKey, expireSeconds, formattedContent);
                multi.hincrby([config.redisNamespace, 'set:path:count:h'].join(':'), path, 1);
            });
        }
```
where only `OK` and `ZERO_RESULTS` responses are cached. In the case of `ZERO_RESULTS` we use `shortExpireSeconds` for a shorter expiry e.g. 3 days rather than 21 days.

### Analytics

```javascript
api.get('/metrics', async ctx => {
    const [getCountRes, setCountRes] = await multiExecAsync(client, multi => {
        multi.hgetall([config.redisNamespace, 'get:path:count:h'].join(':'));
        multi.hgetall([config.redisNamespace, 'set:path:count:h'].join(':'));
    });
    const getCount = reduceAllProperties(getCountRes || {}, value => parseInt(value));
    const setCount = reduceAllProperties(setCountRes || {}, value => parseInt(value));
    const metrics = {getCount, setCount};
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
```
where for Mobile browsers we format the metrics in HTML. In our desktop browser, we typically have JSON formatter extension installed, and so can view JSON responses. But that is not the case on mobile, and perhaps we want to manually monitor the metrics on our mobile phone.

Incidently, we use a related module for basic HTML formatting: https://github.com/evanx/render-html-rpf

### Appication archetype

Incidently `lib/index.js` uses the `redis-koa-app-rpf` application archetype.
```
require('redis-koa-app-rpf')(require('./spec'), require('./main'));
```
where we extract the `config` from `process.env` according to the `spec` and invoke our `main` function.

See https://github.com/evanx/redis-koa-app-rpf.

This provides lifecycle boilerplate to reuse across similar applications.

<hr>
https://twitter.com/@evanxsummers
