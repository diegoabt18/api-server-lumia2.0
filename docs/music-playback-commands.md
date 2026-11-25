# Music Playback Commands Implementation

## Overview

Direct music playback commands for Lumia admin chat using Desktop Agent to control Brave browser. Replaces the removed MongoDB-based music system (phases 1-8) with a simpler, browser-centric approach using YouTube search and playback.

## Architecture

```
Lumia Admin Frontend
    ↓
  Chat (useLumi.ts)
    ↓
  Command Detection (/play, /reproduce, /music)
    ↓
  POST /api/admin/lumi/music/play (lumia-admin BFF)
    ↓
  POST /admin/lumi/music/play (Main Server)
    ↓
  Desktop Agent (Browser Automation)
    ↓
  Brave Browser → YouTube Search → Video Playback
```

## Implementation Status

### ✅ Completed

#### Phase 1: Command Recognition (lumia-admin frontend)
- **File:** `app/features/lumi/composables/useLumi.ts`
- **Functions:**
  - `isMusicCommand(content)`: Detects `/play`, `/reproduce`, `/music` prefixes
  - `extractMusicQuery(content)`: Parses song/artist from command text
  - `playMusic(query, pendingKey)`: Sends command to server via SSE
- **Features:**
  - Case-insensitive prefix detection
  - Support for multi-word song titles and special characters
  - Streams progress to UI without sending to AI assistant

#### Phase 2: BFF Endpoint (lumia-admin server)
- **File:** `server/api/admin/lumi/music/play.post.ts`
- **Route:** `POST /api/admin/lumi/music/play`
- **Features:**
  - Validates incoming music queries (1-500 characters)
  - Proxies to main server as SSE stream
  - Maintains authentication through BFF layer

#### Phase 3: Main Server Endpoint (server)
- **File:** `src/routes/lumi.routes.ts`
- **Route:** `POST /admin/lumi/music/play`
- **Request Body:**
  ```json
  { "query": "Numb de Linkin Park" }
  ```
- **Response:** Server-Sent Events (SSE)
  ```
  event: token
  data: {"text":"Buscando: Numb de Linkin Park..."}
  
  event: token  
  data: {"text":" Abriendo navegador..."}
  
  event: done
  data: {"text":"Reproduciendo: Numb de Linkin Park","success":true,"url":"https://www.youtube.com/results?search_query=Numb+Linkin+Park"}
  ```
- **Permissions:** Requires `lumi.use` (old music permissions removed)

## Command Prefixes

Three aliases for the same functionality:

```
/play Numb de Linkin Park          # English default
/reproduce Imagine John Lennon     # Spanish (reproduce)
/music Bohemian Rhapsody          # Generic
```

All three prefixes trigger the same command handler and are case-insensitive.

## YouTube URL Generation

The endpoint builds YouTube search URLs without external APIs:

```javascript
const query = encodeURIComponent("Numb Linkin Park")
const url = `https://www.youtube.com/results?search_query=${query}`
// Result: https://www.youtube.com/results?search_query=Numb+Linkin+Park
```

This URL is returned to the client and can be used by Desktop Agent to open and automate Brave browser.

## Testing

### Unit Tests

**lumia-admin:** `app/features/lumi/composables/__tests__/useLumi.music.test.ts`
- Command detection (3 prefixes, case-insensitive)
- Query extraction (edge cases, special characters)
- YouTube URL generation and encoding
- Input validation (length, special characters)

**server:** `src/routes/__tests__/lumi-music-play.test.ts`
- Request validation
- YouTube URL generation
- SSE event formatting
- Permission checks
- Integration scenarios

### Manual Testing Checklist

- [ ] Type `/play Numb` and verify command is detected
- [ ] Type `/reproduce Imagine` and verify command is detected  
- [ ] Type `/music Song Title` and verify command is detected
- [ ] Verify message appears in chat with proper formatting
- [ ] Verify YouTube search URL is correct
- [ ] Verify SSE events stream properly to UI
- [ ] Verify error handling for empty queries
- [ ] Verify error handling for very long queries (>500 chars)

## Next Steps: Desktop Agent Integration

The current implementation streams messages but does NOT yet automate Brave browser. This requires:

### 1. Server-Side: Desktop Agent Dispatch

In `src/routes/lumi.routes.ts`, enhance the `/admin/lumi/music/play` endpoint to:

```typescript
// Dispatch to Desktop Agent
const outcome = await execution.dispatch({
  targetId: device.id,  // Brave browser device
  operation: 'browser.youtube_play',
  arguments: {
    query: 'Numb Linkin Park',
    url: 'https://www.youtube.com/results?search_query=Numb+Linkin+Park'
  },
  timeoutMs: 30000
})
```

### 2. Desktop Agent Sidecar: Brave Automation

Implement browser automation task:

```
1. Open Brave browser (or reuse existing instance)
2. Navigate to YouTube search URL
3. Wait for page to load
4. Identify first video result
5. Click video title/thumbnail
6. Wait for video player to load
7. Verify audio stream is active (audio element playing)
8. Report success with video metadata
9. Report error if any step fails
```

### 3. Frontend: Show Progress

Enhance `LumiMessages.vue` to display:
- Desktop Agent device status
- Browser automation progress
- Playback verification indicator
- Cancellation option

## Security Considerations

- **No external APIs:** Only YouTube UI automation, no Data API v3
- **No scraping:** Uses visible browser controls only
- **User authorization:** Explicit `/play` command is authorization (no confirmation needed)
- **URL building:** Safe parameter encoding with `encodeURIComponent()`
- **Permission-based:** Requires `lumi.use` permission
- **No credentials:** No YouTube login needed (public search pages)

## Known Limitations

1. **No playlist support:** Single song search only
2. **No quality selection:** Always uses first result
3. **Limited error messages:** Generic "playback failed" messages
4. **No playback control:** Can't skip, pause, or adjust volume after starting
5. **Browser-dependent:** Requires Brave/Chrome installed on Desktop Agent machine
6. **No offline mode:** Requires internet access for YouTube

## Files Modified

- `lumia-admin/app/features/lumi/composables/useLumi.ts` - Command detection
- `lumia-admin/server/api/admin/lumi/music/play.post.ts` - BFF endpoint
- `server/src/routes/lumi.routes.ts` - Main server endpoint
- `lumia-admin/app/features/lumi/composables/__tests__/useLumi.music.test.ts` - Frontend tests
- `server/src/routes/__tests__/lumi-music-play.test.ts` - Backend tests

## References

- **Desktop Agent:** `lumia-desktop-agent` project, phase 2 (browser automation)
- **Previous system:** `LUMI_MUSICA_ESTADO.md` documents removed YouTube Data API v3 implementation
- **Lumia Architecture:** `server/docs/modules/lumi.md`
