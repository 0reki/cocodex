# CoCodex systemd units

- `cocodex.service` runs the release binary built from `crates/proxy`
- `cocodex.target`

## Install

Build the binary first:

```bash
cargo build --release --manifest-path crates/proxy/Cargo.toml
```

```bash
sudo cp deploy/systemd/cocodex.service /etc/systemd/system/
sudo cp deploy/systemd/cocodex.target /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now cocodex.target
```

## Operate

```bash
sudo systemctl status cocodex.service
sudo journalctl -u cocodex.service -f
sudo systemctl restart cocodex.service
```

After editing the unit: `sudo systemctl daemon-reload && sudo systemctl restart cocodex.target`.

## Notes

- Paths use systemd `%h`, so they follow the `User=` home directory. The default
  checkout is `%h/cocodex`; adjust `WorkingDirectory`, `EnvironmentFile` and
  `ExecStart` if yours differs.
- `.env` is loaded from `%h/cocodex/.env`; relative paths such as
  `COCODEX_CONFIG_PATH=./data/config.json` resolve against `WorkingDirectory`.
- Stopping sends `SIGTERM`; queued settlements are written before exit.
