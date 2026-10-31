# Backend test

`e2e.mjs` checks the real backend from upload to delete: who may upload, signed
links, hidden and published items, prompt protection, rate limiting, views,
Trending, ad rules, categories and file removal.

It needs Docker. It runs against a local Supabase, with SeaweedFS standing in for
R2 because it verifies S3 signatures the same way. Check the "storage refuses"
lines in the output: they prove signatures are really being enforced.

From the project root:

```powershell
supabase start -x imgproxy,vector,logflare,studio,realtime,storage-api,mailpit,postgres-meta,supavisor

docker run -d --name prompt-lab-s3 -p 9123:8333 chrislusf/seaweedfs:latest server -s3 -dir=/tmp -volume.max=5
# After about 10 seconds:
@'
s3.bucket.create -name videos
s3.configure -user tester -access_key localtestkey -secret_key localtestsecret123 -actions Admin,Read,Write,List -apply
s3.configure -user anonymous -actions Read -apply
'@ | docker exec -i prompt-lab-s3 weed shell

# In a second terminal:
supabase functions serve --env-file supabase/tests/local-functions.env --no-verify-jwt
```

Then set `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_KEY` from
`supabase status -o env`, set `S3_PUBLIC_BASE=http://127.0.0.1:9123/videos`, and
run this from `admin-panel/` after `npm install`:

```powershell
node ../supabase/tests/e2e.mjs
```

Afterwards: `supabase stop` and `docker rm -f prompt-lab-s3`.

This does not test real R2 or a hosted Supabase project. Run through one upload
after deploying.
