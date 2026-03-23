# cloud-mail

Utilities for cloud mail inbox API.

## Usage

```ts
import { CloudMailClient } from "@workspace/cloud-mail";

const client = new CloudMailClient();
const otp = await client.waitForOpenAiOtp({
  accountEmail: "your@email.com",
  toEmail: "your@email.com",
});

console.log("otp:", otp);
```

## Notes

- Default `Authorization` token is embedded as requested, but you can override:

```ts
const client = new CloudMailClient({ authorization: "your-token" });
```
