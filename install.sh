#!/usr/bin/env bash
# Install Voice Audio Rus into a DeepSeek Harness profile with one command.
#
#   ./install.sh                 # auto-detect dsh and profile (desktop, else web)
#   ./install.sh --profile web   # target an explicit profile
#   ./install.sh --copy          # copy files into the profile instead of linking
#   ./install.sh --uninstall     # remove the plugin from the profile
#
# Env: DSH_BIN (path to dsh), DSH_HOME (default ~/.dsh)
set -euo pipefail

say()  { printf '\033[36m•\033[0m %s\n' "$1"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '\033[31m×\033[0m %s\n' "$1" >&2; exit 1; }

PROFILE=""
MODE="link"
UNINSTALL=0
DSH_ARG=""
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --profile|-p) [ $# -ge 2 ] || fail "нужно значение для $1"; PROFILE="$2"; shift 2 ;;
    --copy)       MODE="file"; shift ;;
    --link)       MODE="link"; shift ;;
    --uninstall)  UNINSTALL=1; shift ;;
    --dsh)        [ $# -ge 2 ] || fail "нужно значение для $1"; DSH_ARG="$2"; shift 2 ;;
    --dry-run|-n) DRY_RUN=1; shift ;;
    --help|-h)    sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)            fail "неизвестный аргумент: $1 (см. --help)" ;;
  esac
done

# ---------------------------------------------------------------- plugin

ROOT="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$ROOT/plugin"
MANIFEST="$PLUGIN_DIR/package.json"
[ -f "$MANIFEST" ] || fail "не найден $MANIFEST — запустите скрипт из каталога репозитория Voice Audio Rus"
command -v node >/dev/null 2>&1 || fail "нужен node (он уже есть у DSH, добавьте его в PATH)"

NAME="$(node -e 'const m=require(process.argv[1]);if(!m.name)process.exit(1);process.stdout.write(m.name)' "$MANIFEST")" \
  || fail "в $MANIFEST нет поля name"
PATCH="$(node -e 'const m=require(process.argv[1]);process.stdout.write((m.dsh&&m.dsh.bundle&&m.dsh.bundle.patch)||"")' "$MANIFEST")"
[ -n "$PATCH" ] || fail "$NAME не является DSH-бандлом: нет dsh.bundle.patch в package.json"
[ -f "$PLUGIN_DIR/$PATCH" ] || fail "не найден файл патча $PATCH внутри $PLUGIN_DIR"

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

SPEC="$MODE:$PLUGIN_DIR"

printf '\n\033[97mVoice Audio Rus\033[0m\n'
printf '  плагин : %s\n' "$NAME"
printf '  каталог: %s\n' "$PLUGIN_DIR"
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
  printf '  2. Плагины → Voice Audio Rus → «Скачать все модели».\n'
  printf '  3. Правки клиента подхватываются по Ctrl+R после `node tools/build.mjs`.\n'
fi
