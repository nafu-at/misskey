# Misskey Backend
![](../../assets/backend.png)

## Recovering the root account’s second factor

Sign in with your password and one of the saved backup codes. In Settings → Security,
renew the authenticator and save the new backup codes.

If the root account has lost every factor and backup code, an operator with server
console access can run the following command in the Misskey application directory.
Supply the root account ID to confirm the account to recover.

```sh
pnpm cli reset-root-mfa <root-account-id>
```

For a Compose service named `misskey`, use
`docker compose exec misskey pnpm cli reset-root-mfa <root-account-id>`.
The command checks the instance’s root account ID and clears its registered factors.
When its role requires two-factor authentication, existing tokens are revoked.
Sign in again with the account password, enroll an authenticator, save the backup
codes, and reauthorize external applications.
