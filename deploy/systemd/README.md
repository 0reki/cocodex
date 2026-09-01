# CoCodex systemd units

This folder contains production daemon units for the Express backend:

- `cocodex.service` (runs root `pnpm start`)
- `cocodex.target`

## Install

Install dependencies and compile the backend first:

```bash
pnpm install --frozen-lockfile
pnpm build
```

```bash
sudo cp deploy/systemd/cocodex.service /etc/systemd/system/
sudo cp deploy/systemd/cocodex.target /etc/systemd/system/
sudo systemctl daemon-reload
```

## Enable and start

```bash
sudo systemctl enable --now cocodex.target
```

## Status and logs

```bash
sudo systemctl status cocodex.service
sudo journalctl -u cocodex.service -f
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
```

## Notes

- Paths in `cocodex.service` use systemd `%h`, so they follow the configured `User=` home directory automatically.
- Default repo path is `%h/cocodex`. If your checkout directory name is different, edit `WorkingDirectory` and `EnvironmentFile`.
- Node.js and pnpm must be available in the service user's `PATH`.
- `.env` is loaded from `%h/cocodex/.env`.
