# pod-explorer
Block explorer for PoD

## CI/CD deploy to S3

This repo includes a GitHub Actions workflow at
[`.github/workflows/deploy.yml`](/Users/ith/nk/pod-explorer/.github/workflows/deploy.yml).

It does the following on every push to `main` and on manual dispatch:

- installs dependencies with `npm ci`
- builds the app with `npm run build`
- syncs `dist/` to S3
- uploads `index.html` separately with `no-cache`
- optionally invalidates CloudFront

### GitHub configuration

Add these in GitHub before enabling the workflow:

Secrets:

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`

Repository variables:

- `AWS_REGION`
- `S3_BUCKET`
- `S3_PREFIX` (optional)
- `CLOUDFRONT_DISTRIBUTION_ID` (optional)

### Notes

- This app uses hash routes, so S3/CloudFront does not need SPA path rewrites for internal explorer pages.
- `index.html` is uploaded with `no-cache` so new deployments are picked up quickly.
- Built assets are uploaded with a long immutable cache header.
