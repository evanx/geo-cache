
# geo-cache

Redis-based caching proxy for Google Maps API queries.

<img src="https://raw.githubusercontent.com/evanx/geo-cache/master/docs/readme/main.png"/>

## Use case

We require a local proxy to cache requests to Google Maps API into Redis.

## Usage

We use the same path and query as per Google Maps API e.g.:
```
$ curl 'http://localhost:8888/maps/api/geocode/json' \
  -G --data-urlencode 'address=Waitrose, Witney, Oxfordshire, UK' |
  grep formatted | sed 's/^\s*//'
"formatted_address": "The Woolgate Centre, Woolgate Centre, 25 Market Square, Witney OX28 6AR, UK",  
```
where this service is running on port `8888`

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

```
docker run --network=host -e apiKey=$MAPS_API_KEY -d geo-cache
```
where we must provide our `apiKey` for the Google Maps API.

For example, it might be set in the environment as `MAPS_API_KEY`

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
$ redis-cli get cache-geo-cache:64bdaff72bfc67deb55326022371ffef3ace9c7b:json | jq '.' | grep status
  "status": "OK",
```

Check the TTL:
```
$ redis-cli ttl cache-geo-cache:64bdaff72bfc67deb55326022371ffef3ace9c7b:json
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
        httpPort: {
            description: 'the HTTP port',
            default: 8888
        },
        loggerLevel: {
            description: 'the logging level',
            default: 'info',
            example: 'debug'
        }
    }
}
```

## Implementation

See `lib/main.js` https://github.com/evanx/geo-cache/blob/master/lib/main.js
```javascript
module.exports = async ({config, logger, client, app, api}) => {
    api.get('/maps/api/*', async ctx => {
        const path = ctx.params[0];
        const url = 'https://maps.googleapis.com/maps/api/' + path;
        const sha = crypto.createHash('sha1').update(url).digest('hex');
        const cacheKey = [config.redisNamespace, sha, 'content:json'].join(':');
        const [cachedContent] = await multiExecAsync(client, multi => {
            multi.get(cacheKey);
            multi.expire(cacheKey, config.expireSeconds);
        });
        if (cachedContent) {
            ctx.set('Content-Type', 'application/json');
            ctx.body = JSON.stringify(JSON.parse(cachedContent), null, 2);
            return;
        }
        ...
    });
}
```
where we reset the expiry when hit.

If not found in the Redis cache, then we fetch:
```javascript
        const query = Object.assign({}, ctx.query, {key: config.apiKey});
        const urlQuery = url + '?' + Object.keys(query)
        .map(key => [key, encodeURIComponent(query[key])].join('='))
        .join('&');
        const res = await fetch(urlQuery);
        if (res.status !== 200) {
            ctx.statusCode = res.status;
            ctx.body = res.statusText + '\n';
            return;
        }
```

Naturally we put successfully fetched content into our Redis cache:
```javascript
        const fetchedContent = await res.text();
        const formattedContent = JSON.stringify(JSON.parse(fetchedContent), null, 2);
        ctx.set('Content-Type', 'application/json');
        ctx.body = formattedContent;
        await multiExecAsync(client, multi => {
            multi.setex(cacheKey, config.expireSeconds, formattedContent);
        });
```

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
