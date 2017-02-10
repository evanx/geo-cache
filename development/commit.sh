
set -u -e 

echo $# | grep '^0$\|^1$'

  git add -A
  git commit -m "${1-initial}"
  git push

