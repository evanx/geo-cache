

console.error(process.argv, process.stderr.isTTY, process.stdout.isTTY);

require('redis-koa-app-rpf')(require('./spec'), require('./main'));
