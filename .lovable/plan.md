

## Problem

Users are confusing the overlay's static mockups with actual clickable buttons. The current design uses cards with mini UI recreations that look too much like real interactive elements. We need to make it unmistakably an **animated tutorial/demo** rather than a UI with buttons.

## Approach: Animated Step-by-Step Demo

Replace the current card-based layout with a **single centered cinematic animation** that plays out the entire remix process as a looping demo. The overlay will show a realistic recreation of the Lovable UI with an animated cursor performing each action, making it obvious this is a demonstration, not interactive elements.

### Design Concept

A dark overlay with a central "screen recording" style container that loops through 3 phases:

1. **Phase 1 (0-3s)**: Show the project name area at top-left. An animated cursor moves to it and clicks. The dropdown menu slides open (based on the real menu from the user's screenshot: Settings, Remix this project, Publish to profile, etc.)

2. **Phase 2 (3-6s)**: The cursor moves down to "Remix this project" menu item, which highlights on hover. Cursor clicks it. Menu closes.

3. **Phase 3 (6-10s)**: The "Remix project" modal appears (matching the real modal from screenshot 2: project name field, "Include project history" toggle, "Include custom knowledge" toggle). Cursor moves to "Include custom knowledge" toggle and activates it. Then cursor moves to "Remix" button and clicks. Brief success flash.

4. **Loop**: Fade out and restart.

### Visual Cues That This Is Instructional

- A banner at the top: **"📋 Siga estas instruções para criar sua cópia"** with a subtle pulsing border
- Step indicators (1, 2, 3) that light up as each phase plays
- The animated cursor (a custom SVG mouse pointer with a click ripple effect) makes it obvious this is a demonstration
- A "Fechar" (close) or dismiss button so users can close the overlay
- Text labels like "Passo 1", "Passo 2", "Passo 3" that appear during each phase
- The whole thing is inside a rounded container with a subtle "REC" or "TUTORIAL" badge

### Technical Implementation

**Single file change**: `src/components/RemixOverlay.tsx`

- Use `framer-motion` variants with a timeline approach using `useEffect` + `useState` to cycle through phases
- Animated cursor component: a `motion.div` with a mouse pointer SVG that moves between coordinates using `animate={{ x, y }}`
- Click ripple: a small circle that scales up and fades when the cursor "clicks"
- Menu mockup: styled to match the dark theme from screenshot 1 (dark bg, white text, icons)
- Modal mockup: styled to match screenshot 2 (Lovable logo, project name input, toggles, Cancel/Remix buttons)
- Step progress bar at the top showing which step is active
- The entire animation loops every ~10-12 seconds

### Key UI Elements to Recreate (from screenshots)

**Menu (screenshot 1):**
- Dark background (`bg-zinc-900`)
- Items: "Settings", "Remix this project", "Publish to profile", "Rename project", etc.
- "Remix this project" gets a hover highlight

**Modal (screenshot 2):**
- Lovable logo icon
- Title "Remix project"
- Subtitle text
- "Project name" input
- "Include project history" toggle (off)
- "Include custom knowledge" toggle (cursor turns this ON)
- Cancel / Remix buttons

### No External Dependencies Needed

Everything uses existing framer-motion + Tailwind + Lucide icons.

