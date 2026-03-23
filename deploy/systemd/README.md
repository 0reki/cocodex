# CoCodex systemd units

This folder contains production daemon units for the app stack:

- `cocodex.service` (runs root `bun start`)
- `cocodex.target`
- `cocodex-status-poll.service`
- `cocodex-status-poll.timer`
- `cocodex-sync-openai-rate-limits.service`
- `cocodex-sync-openai-rate-limits.timer`

## Install

```bash
sudo cp deploy/systemd/cocodex.service /etc/systemd/system/
sudo cp deploy/systemd/cocodex.target /etc/systemd/system/
sudo cp deploy/systemd/cocodex-status-poll.service /etc/systemd/system/
sudo cp deploy/systemd/cocodex-status-poll.timer /etc/systemd/system/
sudo cp deploy/systemd/cocodex-sync-openai-rate-limits.service /etc/systemd/system/
sudo cp deploy/systemd/cocodex-sync-openai-rate-limits.timer /etc/systemd/system/
sudo systemctl daemon-reload
```

## Enable and start

```bash
sudo systemctl enable --now cocodex.target
sudo systemctl enable --now cocodex-status-poll.timer
sudo systemctl enable --now cocodex-sync-openai-rate-limits.timer
```

## Status and logs

```bash
sudo systemctl status cocodex.service
sudo journalctl -u cocodex.service -f
sudo systemctl list-timers 'cocodex-*'
sudo journalctl -u cocodex-status-poll.service -f
sudo journalctl -u cocodex-sync-openai-rate-limits.service -f
```

## Stop

```bash
sudo systemctl stop cocodex.service
```

## Restart

```bash
sudo systemctl restart cocodex.service
```

## Apply unit changes

```bash
sudo systemctl daemon-reload
sudo systemctl restart cocodex.target
sudo systemctl restart cocodex-status-poll.timer
sudo systemctl restart cocodex-sync-openai-rate-limits.timer
```

## Notes

- Paths in `cocodex.service` use systemd `%h`, so they follow the configured `User=` home directory automatically.
- Default repo path is `%h/cocodex`. If your checkout directory name is different, edit `WorkingDirectory` and `EnvironmentFile`.
- Bun is loaded from `%h/.bun/bin/bun`.
- `.env` is loaded from `%h/cocodex/.env`.
- `status:poll` and `sync:openai-rate-limits` are configured as systemd timers, each running every 5 minutes.
