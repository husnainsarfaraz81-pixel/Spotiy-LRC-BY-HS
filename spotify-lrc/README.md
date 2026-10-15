# Spotify → Synced Lyrics (.lrc)

Paste a **Spotify track / playlist / album link** → get **synced .lrc lyrics** for every song.
Ya phir **manual search** se song name + artist likh kar lyrics lo.

**100% free. Koi paid API nahi. Koi data store nahi hota. Koi Spotify app/keys banane ki zaroorat nahi.**

## Kaise kaam karta hai

1. Spotify link se track list **bina kisi API key ke** nikalta hai (Spotify ke public embed pages se — koi login, koi Premium, koi sp_dc cookie nahi)
2. Har track ke liye **lrclib.net** ka free API hit hota hai (koi key nahi chahiye)
3. Synced lyrics mil jayein to `.lrc` file, warna plain lyrics / instrumental / not-found
4. Playlist ke saare lyrics ek click me **ZIP** me download

lrclib ka poora database (~100GB) download karne ki **zaroorat nahi** — sab live API se aata hai.

## Option 1: Local (1-click shortcut) ⚡

1. [nodejs.org](https://nodejs.org) se **LTS** install karo (ek dafa)
2. Is folder me **start.bat** (Windows) par double-click karo — ya Mac/Linux pe `sh start.sh`
3. Browser khud khul jayega: `http://localhost:3000`

Band karne ke liye terminal window close kar do.

## Option 2: Netlify pe deploy (hamesha online, phone se bhi) ☁️

1. [github.com](https://github.com) pe free account banao → **New repository** → is folder ke saare files drag-drop karke upload karo (git ki zaroorat nahi)
2. [app.netlify.com](https://app.netlify.com) → **Add new site → Import an existing project** → GitHub repo select karo → **Deploy** (koi build command nahi chahiye — `netlify.toml` sab sambhal lega)
3. 1 minute me tumhe `https://tumhara-naam.netlify.app` jaisa link mil jayega — **hamesha on, kahin se bhi kholo**

## Spotify API keys (optional — aksar zaroorat nahi)

Keyless mode me playlist ke **pehle ~50 tracks** milte hain (aksar kaafi hota hai).
Agar 50+ gaanon wali playlist **poori** chahiye to page pe ⚙️ me Client ID/Secret dalo.

**Note (Feb 2026 se):** Spotify ne naye developer apps ke liye **Premium lazmi** kar diya hai —
bina Premium ke banayi hui app ki keys kaam nahi karengi (API 403 dega). Isi liye default
keyless mode hai jo hamesha kaam karta hai.

## Notes

- lrclib free API hai isliye batch me har request ke darmiyan ~0.4s ka waqfa rakha gaya hai (unki guideline). Bari playlist me 1-2 minute lag sakte hain — progress bar dikhega.
- Jo gaane lrclib me nahi milte unke liye "Not found" aayega.
- Server tumhari keys ya lyrics kahin save nahi karta.
