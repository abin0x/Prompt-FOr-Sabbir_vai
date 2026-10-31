# Prompt Lab ব্যাকএন্ড সেটআপ

ভিডিও ও ছবি থাকবে **Cloudflare R2**-তে, আর লেখা, prompt ও লগইন থাকবে **Supabase**-এ। আপনি **Dashboard** থেকে আপলোড করবেন।

```
Dashboard (admin-panel/) ──> Edge Function ──> সাইন করা আপলোড লিংক
       │                                            │
       │ title, prompt                              ▼
       ▼                                     Cloudflare R2 (ভিডিও, ছবি)
Supabase (লিস্ট, prompt, ক্যাটাগরি)                  │
       ▲                                            │
       └──────────── Prompt Lab অ্যাপ ◄──────────────┘
```

## ফোল্ডার

| ফোল্ডার | কী আছে |
|---|---|
| `supabase/migrations/` | ডাটাবেসের টেবিল, নিরাপত্তা নিয়ম, ফাংশন |
| `supabase/functions/` | `r2-upload-url` (আপলোড লিংক) ও `r2-delete` (ফাইল মোছা) |
| `supabase/tests/` | পুরো ব্যাকএন্ডের পরীক্ষা |
| `admin-panel/` | Dashboard |

## ১. Supabase

1. [supabase.com](https://supabase.com)-এ নতুন প্রজেক্ট খুলুন। Region হিসেবে **Singapore** নিন, বাংলাদেশের কাছে। Database password যত্নে রাখুন।
2. **Project Settings → API** থেকে **Project URL** আর **anon/publishable key** নোট করুন।
3. **Project Settings → General** থেকে **Project ref** নোট করুন।
4. **Authentication → Sign In / Providers**-এ **Allow new users to sign up** বন্ধ করুন। ইউজারদের লগইন নেই, তাই বাইরের কেউ অ্যাকাউন্ট খুলতে পারবে না।
5. **Authentication → Users → Add user** থেকে আপনার admin অ্যাকাউন্ট বানান (ইমেইল ও শক্ত পাসওয়ার্ড)। **Auto Confirm** চালু রাখুন।

## ২. Cloudflare R2

1. **R2 → Create bucket**: নাম দিন `prompt-lab-media`।
2. **R2 → Manage API tokens → Create API token**:
   - Permission: **Object Read & Write**
   - Specify bucket: শুধু `prompt-lab-media`
   - তৈরি হলে **Access Key ID** ও **Secret Access Key** নোট করুন। Secret একবারই দেখায়।
3. R2-র মূল পেজ থেকে **Account ID** নোট করুন।
4. বাকেট → **Settings → Public access**:
   - লাইভের জন্য: **Custom Domain** যোগ করুন, যেমন `media.yourdomain.com`।
   - শুধু পরীক্ষার জন্য: **r2.dev** লিংক চালু করতে পারেন। এতে রেট লিমিট আছে, লাইভে ব্যবহার করবেন না।
5. বাকেট → **Settings → CORS policy**-তে এটা বসান। Dashboard অনলাইনে তোলার পর তার ঠিকানাটাও যোগ করবেন:

```json
[
  {
    "AllowedOrigins": ["http://localhost:5173"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["content-type", "cache-control"],
    "MaxAgeSeconds": 3600
  }
]
```

## ৩. Credential কোথায় রাখবেন

**গোপন জিনিস চ্যাটে পাঠাবেন না।** `supabase/.env.production.example` ফাইলটা কপি করে `supabase/.env.production` বানান, সেখানে বসান। এই ফাইল `.gitignore`-এ আছে।

| জিনিস | কোথায় দেবেন |
|---|---|
| Project URL, Project ref, anon/publishable key | চ্যাটে দেওয়া যাবে, এগুলো গোপন নয় |
| R2 পাবলিক ডোমেইন, বাকেটের নাম | চ্যাটে দেওয়া যাবে |
| R2 Account ID, Access Key ID, **Secret Access Key** | শুধু `.env.production` ফাইলে |
| Supabase লগইন | নিজে টার্মিনালে `supabase login` চালাবেন |
| Admin পাসওয়ার্ড, Database password | কাউকে দেবেন না; ডাটাবেস লিংকের সময় নিজে টাইপ করবেন |

**`service_role` key কোথাও লাগবে না।** Dashboard বা অ্যাপে এটা কখনো বসাবেন না।

## ৪. ডিপ্লয়

প্রজেক্টের মূল ফোল্ডারে:

```bash
supabase login
supabase link --project-ref YOUR-PROJECT-REF
supabase db push
supabase secrets set --env-file supabase/.env.production
supabase functions deploy r2-upload-url
supabase functions deploy r2-delete
```

তারপর Supabase-এর **SQL Editor**-এ আপনার admin অ্যাকাউন্টকে admin বানান:

```sql
insert into public.admins (user_id)
select id from auth.users where email = 'আপনার-ইমেইল';
```

## ৫. Dashboard চালানো

```bash
cd admin-panel
npm install
cp .env.example .env     # মান তিনটা বসান
npm run dev              # http://localhost:5173
```

**এখনই শুধু দেখতে চাইলে:** `npm run demo` চালান। কোনো অ্যাকাউন্ট লাগে না, কিছু সেভও হয় না।

অনলাইনে তুলতে `npm run build` করে `dist/` ফোল্ডারটা Netlify বা Cloudflare Pages-এ দিন, আর একই তিনটা মান সেখানকার Environment variables-এ বসান। এরপর:

1. সেই ঠিকানা R2-র CORS-এ যোগ করুন।
2. `ADMIN_ORIGIN=https://আপনার-dashboard-ঠিকানা` সেট করে `supabase secrets set --env-file supabase/.env.production` আবার চালান।

## Dashboard-এ কী কী আছে

| পেজ | কাজ |
|---|---|
| Overview | আসল সংখ্যা, দৈনিক ভিউ, Generate ও Copy-এর হিসাব, অ্যাপের অবস্থা, স্টোরেজ, যা ঠিক করতে হবে |
| Library | আপলোড, Bulk upload, Schedule, এডিট, প্রিভিউ, Pin, লুকানো, একসাথে অনেকগুলো বদলানো, টেবিল বা গ্রিড ভিউ |
| Categories | যোগ, নাম বদল, ক্রম বদল (Home-এর chip-এর ক্রম), লুকানো, মুছে ফেলা |
| Reports | অ্যাপে এখন Report বাটন নেই, তাই এই পেজ খালি থাকবে |
| Ad controls | অ্যাড চালু/বন্ধ, প্রতিটা জায়গার আলাদা সুইচ, Unit ID, সীমা |
| Policy check | সেটিং মিলিয়ে দেখা, লঞ্চের চেকলিস্ট |
| App settings | Maintenance mode, ঘোষণা, Home-এর লেখা ও প্রথম ভিউ, Onboarding-এর লেখা, Media address, ভার্সন, Privacy ও Terms লিংক |
| Activity | কে কখন কী বদলেছে |

সেটিং অ্যাপে পৌঁছায় পরের বার খোলা, pull to refresh বা ৩০ মিনিট পর ফেরার সময়। ছবির সাদা বা transparent বর্ডার আপলোডের সময় নিজে থেকে কেটে যায়। Prompt ছাড়া আইটেম শুধু Hidden থাকতে পারে।

**আয়ের হিসাব এখানে নেই।** সেটা AdMob অ্যাকাউন্টে দেখতে হবে।

## নিরাপত্তা

- R2-র গোপন key শুধু Edge Function-এ থাকে, ব্রাউজারে যায় না।
- ইউজাররা শুধু publish করা আইটেম দেখতে পায়। prompt টেবিল সরাসরি পড়া যায় না, শুধু `get_prompt` দিয়ে আসে।
- `get_prompt`-এ প্রতি IP-তে মিনিটে ৩০০ বারের সীমা আছে। এটা Interstitial অ্যাড দেখা প্রমাণ করতে পারে না, তাই কেউ চাইলে ধীরে ধীরে prompt নিতে পারবে। একই মোবাইল অপারেটরের অনেক ইউজারের একই IP থাকতে পারে বলে সীমাটা উঁচু রাখা হয়েছে।
- আপলোডের সাইজ সীমা (ভিডিও ১০০ MB, ছবি ১৫ MB) শুধু লিংক দেওয়ার আগে পরীক্ষা হয়। আপলোডের অধিকার শুধু admin-এর, তাই এটুকুই যথেষ্ট ধরা হয়েছে।
