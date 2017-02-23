
docker build -t geo-cache https://github.com/evanx/geo-cache.git
docker rm -f `docker ps -q -f name=geo-cache`
docker run --name geo-cache -d \
  --network=host --restart unless-stopped \
  -e NODE_ENV=production \
  -e httpPort=8851 \
  geo-cache
