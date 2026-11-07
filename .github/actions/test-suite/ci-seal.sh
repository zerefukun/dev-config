#!/bin/bash
# sudo --non-interactive /usr/local/sbin/ci-seal --path P --tmpdir T -- CMD [ARGS...]
#
# Runs CMD with ARGS, verbatim, as the account that invoked sudo (never root),
# in a fresh network namespace whose only interface is lo, up. CMD's
# environment is exactly PATH=P, TMPDIR=T, HOME (the account's home) and
# LANG=C.UTF-8. CMD replaces this script, so the signals sudo relays reach it
# and no wrapper process is left. Refuses an invoker that is root or not an
# account, and any other argument shape.
set -euo pipefail

usage() {
  echo "usage: sudo --non-interactive $0 --path P --tmpdir T -- CMD [ARGS...]" >&2
  exit 64
}
refuse() {
  echo "ci-seal: refused: $*" >&2
  exit 77
}

[ "$(id -u)" = 0 ] || refuse "run it through sudo"
uid=${SUDO_UID-}
gid=${SUDO_GID-}
[[ $uid =~ ^[1-9][0-9]*$ ]] || refuse "the invoker is root or unknown"
[[ $gid =~ ^[0-9]+$ ]] || refuse "the invoker's group is unknown"
account=$(getent passwd "$uid") || refuse "uid $uid is not an account"
IFS=: read -r _ _ _ primary _ home _ <<<"$account"
[ "$primary" = "$gid" ] || refuse "gid $gid is not uid $uid's group"

[ "${1-}" = --path ] && [ $# -ge 2 ] || usage
path=$2
[ "${3-}" = --tmpdir ] && [ $# -ge 4 ] || usage
tmpdir=$4
[ "${5-}" = -- ] && [ $# -ge 6 ] || usage
shift 5

# The positional parameters below are the inner bash's, expanded there.
# shellcheck disable=SC2016
exec unshare --net -- /bin/bash -c '
  set -e
  ip link set lo up
  exec setpriv --reuid="$1" --regid="$2" --init-groups --no-new-privs --inh-caps=-all --bounding-set=-all -- \
    env -i PATH="$3" TMPDIR="$4" HOME="$5" LANG=C.UTF-8 "${@:6}"
' ci-seal "$uid" "$gid" "$path" "$tmpdir" "$home" "$@"
