
set -u -x

mkdir -p tmp

redis-cli keys cache-geo-cache:* | xargs -n 1 redis-cli del

echo '
redis-cli keys cache-geo-cache:* | head
redis-cli keys cache-geo-cache:* | wc -l
' | sed '/^$/d' | tee tmp/keys.sh | dash -x
cat tmp/keys.sh
ls -l tmp/keys.sh

(
  echo 'client sleep'
  sleep 1
  echo 'client curl'
  curl 'http://localhost:8851/maps/api/geocode/json' -G --data-urlencode 'address=20 Falstaff Close, Eynsham OX29 4QA'
  redis-cli keys cache-geo-cache:*
) &

echo 'start server'
apiKey=$MAPS_API_KEY node --harmony lib/index.js
