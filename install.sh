#!/usr/bin/env bash
# Voice Audio Rus — install into a DeepSeek Harness profile with one command.
#
# Works from a cloned repository (uses ./plugin) or standalone: with no repository
# next to this script it downloads the sources from GitHub first.
set -euo pipefail

usage() {
  cat <<'EOF'
Voice Audio Rus installer

  ./install.sh                     auto-detect dsh and profile (desktop, else web)
  ./install.sh --profile web       target an explicit profile
  ./install.sh --copy              copy files into the profile instead of linking
  ./install.sh --uninstall         remove the plugin from the profile
  ./install.sh --dry-run           show the plan and change nothing
  ./install.sh --source <dir>      install from a local checkout
  ./install.sh --version v0.2.2    GitHub ref to download (default: main)
  ./install.sh --repo owner/name   GitHub repository (default: Vasyarot/voice-audio-rus)
  ./install.sh --from-github       ignore the local checkout and download instead
  ./install.sh --dest <dir>        cache directory for downloaded sources

Standalone, without cloning:

  curl -fsSL https://raw.githubusercontent.com/Vasyarot/voice-audio-rus/main/install.sh | bash

Env: DSH_BIN (path to dsh), DSH_HOME (default ~/.dsh)
EOF
}

say()  { printf '\033[36m>\033[0m %s\n' "$1" >&2; }
ok()   { printf '\033[32mok\033[0m %s\n' "$1" >&2; }
fail() { printf '\033[31mx\033[0m %s\n' "$1" >&2; exit 1; }

PROFILE=""
MODE="link"
UNINSTALL=0
DSH_ARG=""
DRY_RUN=0
SOURCE=""
VERSION="main"
REPO="Vasyarot/voice-audio-rus"
FROM_GITHUB=0
DEST=""

while [ $# -gt 0 ]; do
  case "$1" in
    --profile|-p) [ $# -ge 2 ] || fail "нужно значение для $1"; PROFILE="$2"; shift 2 ;;
    --copy)       MODE="file"; shift ;;
    --link)       MODE="link"; shift ;;
    --uninstall)  UNINSTALL=1; shift ;;
    --dsh)        [ $# -ge 2 ] || fail "нужно значение для $1"; DSH_ARG="$2"; shift 2 ;;
    --dry-run|-n) DRY_RUN=1; shift ;;
    --source)     [ $# -ge 2 ] || fail "нужно значение для $1"; SOURCE="$2"; shift 2 ;;
    --version)    [ $# -ge 2 ] || fail "нужно значение для $1"; VERSION="$2"; shift 2 ;;
    --repo)       [ $# -ge 2 ] || fail "нужно значение для $1"; REPO="$2"; shift 2 ;;
    --from-github) FROM_GITHUB=1; shift ;;
    --dest)       [ $# -ge 2 ] || fail "нужно значение для $1"; DEST="$2"; shift 2 ;;
    --help|-h)    usage; exit 0 ;;
    *)            fail "неизвестный аргумент: $1 (см. --help)" ;;
  esac
done

command -v node >/dev/null 2>&1 || fail "нужен node (он уже есть у DSH, добавьте его в PATH)"

# ---------------------------------------------------------------- source

SCRIPT_DIR=""
SELF="${BASH_SOURCE[0]:-}"
if [ -n "$SELF" ] && [ -f "$SELF" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$SELF")" && pwd)"
fi

has_plugin() {
  [ -n "${1:-}" ] && [ -f "$1/plugin/package.json" ]
}

cache_root() {
  if [ -n "$DEST" ]; then
    printf '%s' "$DEST"
    return
  fi
  if [ "$(uname -s)" = "Darwin" ]; then
    printf '%s' "$HOME/Library/Application Support/VoiceAudioRus"
    return
  fi
  printf '%s' "${XDG_DATA_HOME:-$HOME/.local/share}/voice-audio-rus"
}

fetch_repo() {
  local dest="$1" tmp inner candidate url_heads url_tags
  command -v tar >/dev/null 2>&1 || fail "нужен tar"
  command -v curl >/dev/null 2>&1 || command -v wget >/dev/null 2>&1 || fail "нужен curl или wget"

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  url_heads="https://codeload.github.com/$REPO/tar.gz/refs/heads/$VERSION"
  url_tags="https://codeload.github.com/$REPO/tar.gz/refs/tags/$VERSION"

  say "скачиваю $REPO@$VERSION с GitHub"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url_heads" -o "$tmp/repo.tgz" 2>/dev/null ||
      curl -fsSL "$url_tags" -o "$tmp/repo.tgz" 2>/dev/null ||
      fail "не удалось скачать $REPO@$VERSION (проверьте сеть, ref и --repo)"
  else
    wget -qO "$tmp/repo.tgz" "$url_heads" 2>/dev/null ||
      wget -qO "$tmp/repo.tgz" "$url_tags" 2>/dev/null ||
      fail "не удалось скачать $REPO@$VERSION (проверьте сеть, ref и --repo)"
  fi

  tar -xzf "$tmp/repo.tgz" -C "$tmp" || fail "не удалось распаковать архив"
  inner=""
  for candidate in "$tmp"/*/; do
    [ -d "$candidate" ] || continue
    inner="${candidate%/}"
    break
  done
  [ -n "$inner" ] || fail "архив пустой"
  has_plugin "$inner" || fail "в архиве нет plugin/package.json — $REPO@$VERSION не похож на Voice Audio Rus"

  rm -rf "$dest"
  mkdir -p "$dest"
  cp -R "$inner"/. "$dest"/
  rm -rf "$tmp"
  trap - EXIT
  ok "исходники обновлены: $dest"
}

ROOT=""
if [ -n "$SOURCE" ]; then
  has_plugin "$SOURCE" || fail "в $SOURCE нет plugin/package.json"
  ROOT="$(cd "$SOURCE" && pwd)"
elif [ "$FROM_GITHUB" -eq 0 ] && has_plugin "$SCRIPT_DIR"; then
  ROOT="$SCRIPT_DIR"
elif [ "$UNINSTALL" -eq 1 ]; then
  ROOT=""
else
  CACHE="$(cache_root)/src"
  fetch_repo "$CACHE"
  ROOT="$CACHE"
  has_plugin "$ROOT" || fail "не удалось подготовить исходники в $CACHE"
fi

PLUGIN_DIR=""
NAME="dsh-plugin-voice-studio"
if [ -n "$ROOT" ]; then
  PLUGIN_DIR="$ROOT/plugin"
  MANIFEST="$PLUGIN_DIR/package.json"
  NAME="$(node -e 'const m=require(process.argv[1]);if(!m.name)process.exit(1);process.stdout.write(m.name)' "$MANIFEST")" \
    || fail "в $MANIFEST нет поля name"
  if [ "$UNINSTALL" -eq 0 ]; then
    PATCH="$(node -e 'const m=require(process.argv[1]);process.stdout.write((m.dsh&&m.dsh.bundle&&m.dsh.bundle.patch)||"")' "$MANIFEST")"
    [ -n "$PATCH" ] || fail "$NAME не является DSH-бандлом: нет dsh.bundle.patch в package.json"
    [ -f "$PLUGIN_DIR/$PATCH" ] || fail "не найден файл патча $PATCH внутри $PLUGIN_DIR"
    [ -f "$PLUGIN_DIR/client.js" ] || fail "в $PLUGIN_DIR нет собранного client.js — это не готовый релиз"
  fi
elif [ "$UNINSTALL" -eq 0 ]; then
  fail "не удалось получить исходники плагина"
fi

# ---------------------------------------------------------------- dsh

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"

detect_dsh() {
  if [ -n "$DSH_ARG" ]; then
    [ -x "$DSH_ARG" ] || [ -f "$DSH_ARG" ] || fail "указанный dsh не найден: $DSH_ARG"
    printf '%s' "$DSH_ARG"
    return
  fi
  if [ -n "${DSH_BIN:-}" ]; then
    [ -e "$DSH_BIN" ] || fail "DSH_BIN указывает на несуществующий файл: $DSH_BIN"
    printf '%s' "$DSH_BIN"
    return
  fi
  if command -v dsh >/dev/null 2>&1; then
    command -v dsh
    return
  fi
  for candidate in \
    "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
    "$HOME/.local/bin/dsh" \
    "/usr/local/bin/dsh" \
    "/opt/homebrew/bin/dsh"
  do
    if [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return
    fi
  done
  fail "не найден dsh. Установите DSH, добавьте dsh в PATH или укажите --dsh <path>"
}

DSH="$(detect_dsh)"

# ---------------------------------------------------------------- profile

detect_profile() {
  if [ -n "$PROFILE" ]; then
    printf '%s' "$PROFILE"
    return
  fi
  if [ -d "$DSH_HOME_DIR/profiles/desktop" ]; then
    printf 'desktop'
    return
  fi
  printf 'web'
}

PROFILE="$(detect_profile)"
PROFILE_DIR="$DSH_HOME_DIR/profiles/$PROFILE"

if [ ! -d "$PROFILE_DIR" ]; then
  if [ "$PROFILE" = "desktop" ]; then
    fail "профиль desktop не инициализирован ($PROFILE_DIR). Запустите настольное приложение DSH один раз."
  fi
  say "профиль $PROFILE будет создан при первом запуске DSH"
fi

SPEC=""
if [ -n "$PLUGIN_DIR" ]; then
  SPEC="$MODE:$PLUGIN_DIR"
fi

printf '\n\033[97mVoice Audio Rus\033[0m\n'
printf '  плагин : %s\n' "$NAME"
if [ -n "$PLUGIN_DIR" ]; then printf '  откуда : %s\n' "$PLUGIN_DIR"; fi
printf '  dsh    : %s\n' "$DSH"
printf '  профиль: %s (%s)\n' "$PROFILE" "$PROFILE_DIR"
if [ "$UNINSTALL" -eq 1 ]; then
  printf '  режим  : удаление\n\n'
else
  printf '  режим  : %s\n\n' "$SPEC"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  ok "dry-run: команды не выполнялись"
  exit 0
fi

# ---------------------------------------------------------------- run

if [ "$UNINSTALL" -eq 1 ]; then
  say "удаляю $NAME из профиля $PROFILE"
  "$DSH" plugin --profile "$PROFILE" remove "$NAME" || fail "dsh plugin remove завершился с ошибкой"
else
  say "ставлю $NAME в профиль $PROFILE"
  "$DSH" plugin --profile "$PROFILE" add "$SPEC" || fail "dsh plugin add завершился с ошибкой"
fi

# ---------------------------------------------------------------- bundle selection

PROFILE_MANIFEST="$PROFILE_DIR/package.json"
if [ -f "$PROFILE_MANIFEST" ]; then
  node -e '
    const fs = require("node:fs");
    const file = process.argv[1];
    const name = process.argv[2];
    const mode = process.argv[3];
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    const dsh = json.dsh || (json.dsh = {});
    const profile = dsh.profile || (dsh.profile = {});
    const bundles = Array.isArray(profile.bundles) ? profile.bundles : [];
    const has = bundles.indexOf(name) !== -1;
    if (mode === "add" && !has) {
      profile.bundles = bundles.concat([name]);
    } else if (mode === "remove" && has) {
      profile.bundles = bundles.filter(function (item) { return item !== name; });
    } else {
      process.stdout.write("unchanged\n");
      process.exit(0);
    }
    fs.writeFileSync(file, JSON.stringify(json, null, 2) + "\n");
    process.stdout.write(mode === "add" ? "added\n" : "removed\n");
  ' "$PROFILE_MANIFEST" "$NAME" "$([ "$UNINSTALL" -eq 1 ] && echo remove || echo add)" > /tmp/voice-studio-bundles.$$ \
    || fail "не удалось обновить dsh.profile.bundles в $PROFILE_MANIFEST"
  RESULT="$(cat /tmp/voice-studio-bundles.$$)"
  rm -f /tmp/voice-studio-bundles.$$
  case "$RESULT" in
    added)     ok "бандл добавлен в dsh.profile.bundles" ;;
    removed)   ok "бандл убран из dsh.profile.bundles" ;;
    unchanged) ok "бандл уже в нужном состоянии" ;;
  esac
fi

printf '\n'
if [ "$UNINSTALL" -eq 1 ]; then
  ok "Готово. Перезапустите DSH, чтобы плагин исчез из интерфейса."
else
  ok "Готово."
  printf '  1. Перезапустите DSH (настольное приложение) или `dsh web`.\n'
  printf '  2. Плагины -> Voice Audio Rus -> «Скачать все модели».\n'
  printf '  3. Обновить плагин: повторите этот скрипт — он перекачает GitHub@%s.\n' "$VERSION"
fi
