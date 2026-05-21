<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/drive/1Bemm5SfsFUjw9u5_Ti1uOyww-RdL5XCo

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Copy [`.env.example`](.env.example) to `.env.local` and set your Supabase **anon** key from [Project Settings → API](https://supabase.com/dashboard/project/ijkeuncfyaonjermwggl/settings/api) (project `ijkeuncfyaonjermwggl`, not the old `ohbocxuvzrgzqkjocyns` from the initial remix).
3. Optionally set `GEMINI_API_KEY` in `.env.local` for AI Studio features.
4. Run the app: `npm run dev`

**Deploy (Cloudflare / Vite):** set the same `VITE_SUPABASE_*` variables in the hosting dashboard. Do not rely on the `.env` file committed on GitHub `main` — it still points at the wrong Supabase project until removed from the repo.
