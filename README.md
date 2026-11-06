# weir

weir is a local daemon and CLI for your mail. It syncs mail sources, sorts conversations by the
tag and group rules in `config.toml`, writes AI digests, and serves a Web UI on `127.0.0.1`.

## Install

weir needs [Bun](https://bun.sh). Install the latest release:

```sh
bun add -g https://github.com/5u4/weir/releases/latest/download/weir.tgz
```

To install a specific version, put its tag in the URL:

```sh
bun add -g https://github.com/5u4/weir/releases/download/vX.Y.Z/weir.tgz
```

## Run the daemon

The daemon reads `config.toml` in the weir home and does not start without it. An empty file is a
valid config. The daemon listens on port 9347 unless `config.toml` sets `port`.

| Command        | What it does                                                                  |
| -------------- | ----------------------------------------------------------------------------- |
| `weir start`   | Starts the daemon and prints its pid, Web UI URL, and log path.               |
| `weir stop`    | Stops the daemon.                                                             |
| `weir restart` | Stops the daemon if it runs, then starts it.                                  |
| `weir upgrade` | Installs the latest release if it is newer, then restarts a running daemon.   |

## Environment

| Variable        | Default                       | Use                                                    |
| --------------- | ----------------------------- | ------------------------------------------------------ |
| `WEIR_HOME`     | `~/.weir`                     | Holds `config.toml`, `weir.db`, `daemon.json`, and `daemon.log`. |
| `WEIR_RELEASES` | `https://github.com/5u4/weir` | Where `weir upgrade` looks for `releases/latest`.      |

## Develop from source

1. Install dependencies:

   ```sh
   bun install
   ```

2. Give the source build its own home, so it never touches `~/.weir`:

   ```sh
   export WEIR_HOME=/tmp/weir-dev
   mkdir -p "$WEIR_HOME"
   printf 'port = 9348\n' > "$WEIR_HOME/config.toml"
   ```

   The port keeps it clear of an installed daemon on 9347.

3. Run the CLI from source:

   ```sh
   bun apps/cli/src/main.ts start
   ```

   The daemon serves the Web UI only after `bun run build:web`. A source build reports version `dev`
   and `weir upgrade` refuses to run. Update it with `git pull`.

4. Run the demo on synthetic data:

   ```sh
   bun run demo
   ```

   The demo checks search, tags, digests, and faces, then exits. Add `--serve` to keep its Web UI
   running. Add `--fail` to make every source fail to sync after the checks.
