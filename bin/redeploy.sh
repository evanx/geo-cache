
echo "NODE_ENV $NODE_ENV"
docker build -t geo-cache https://github.com/evanx/geo-cache.git
docker rm -f `docker ps -q -f name=geo-cache`
container=`docker run --name geo-cache -d \
  --network=host --restart unless-stopped \
  -e httpPort=8851 \
  -e NODE_ENV=$NODE_ENV \
  geo-cache`
sleep 1 
echo "docker logs $container"
docker logs $container

