# shellcheck shell=bash
# Reads the paths the build tool caches in (BUILD_CACHE, one
# repository-relative path per line), refuses any the action cannot keep, and
# writes the step outputs actions/cache is called with: `paths`, one per line
# in their normal spelling, `key` and `restore-key`. An empty BUILD_CACHE
# writes no paths, and the action builds with no cache at all.
#
# The key is bun.lock alone, plus a suffix unique to the save. A dependency
# change starts a fresh cache; a cache stale against the source is what the
# build tool itself invalidates by content hash, so keying on the source would
# only throw away hits. GitHub never overwrites a cache entry, so each save
# takes a key of its own and the restore takes the newest one under the
# lockfile's prefix: two jobs of one run saving at once each land, and neither
# warns about the other.
set -euo pipefail

refuse() {
  echo "::error::$1"
  exit 1
}

paths=()
while IFS= read -r line; do
  path=${line#"${line%%[![:space:]]*}"}
  path=${path%"${path##*[![:space:]]}"}
  [ -n "$path" ] || continue
  [[ $path != /* ]] || refuse "the build cache path $path is absolute; name a path relative to the repository root, such as .next/cache"
  IFS=/ read -ra segments <<< "$path"
  normal=
  for segment in "${segments[@]}"; do
    case $segment in
      "" | .) ;;
      ..) refuse "the build cache path $path has a .. segment; name a path inside the repository, such as .next/cache" ;;
      *) normal+=${normal:+/}$segment ;;
    esac
  done
  [ -n "$normal" ] || refuse "the build cache path $path is the repository root itself; name the directory the build tool caches in, such as .next/cache"
  # A tree named twice, or inside another named tree, is archived twice and
  # restored over itself.
  for named in "${paths[@]}"; do
    if [[ $normal == "$named" || $normal == "$named"/* || $named == "$normal"/* ]]; then
      refuse "the build cache path $path overlaps $named, named before it; name each directory once, and none inside another"
    fi
  done
  paths+=("$normal")
done <<< "$BUILD_CACHE"

[ "${#paths[@]}" -gt 0 ] || exit 0

[ -f bun.lock ] || refuse "the build cache is keyed on bun.lock, and the repository root has none; commit the lockfile bun install writes"

prefix=build-cache-$(sha256sum bun.lock | cut -c1-16)-
suffix=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
{
  echo "paths<<paths-end"
  printf '%s\n' "${paths[@]}"
  echo "paths-end"
  echo "key=$prefix$suffix"
  echo "restore-key=$prefix"
} >> "$GITHUB_OUTPUT"
