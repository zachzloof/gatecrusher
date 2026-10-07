# SoundCloud ingest fixtures

Hand-written, sanitised samples of the external responses ingest reads. Every id,
slug, name and URL is invented; there is no real `client_id`, token or personal data
here. Modelled on the live shapes on 2026-10-01. Tests serve these through a fake
`fetch` / fake process runner and never touch the network.

| File                                                 | Reproduces                                                                                                                                                                                                                     |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `home.html`                                          | The `<script src>` tags of soundcloud.com that `client_id` discovery follows, plus one third-party script it must ignore.                                                                                                      |
| `resolve-playlist.json`                              | api-v2 `GET /resolve` for a playlist of 7 tracks: the first 2 hydrated, the other 5 as id-only stubs.                                                                                                                          |
| `tracks-hydrated.json`                               | api-v2 `GET /tracks?ids=` for those stubs: out of order, and without track 106 (private or removed tracks are simply left out).                                                                                                |
| `resolve-track.json`                                 | api-v2 `GET /resolve` for a URL that is a track, not a playlist.                                                                                                                                                               |
| `yt-dlp-playlist.json`                               | `yt-dlp -J --flat-playlist` for the same playlist: a `null` entry (unreadable track), a sparse entry, and a duplicate. No purchase links — yt-dlp has none.                                                                    |
| `my-playlists-page1.json`, `my-playlists-page2.json` | api-v2 `GET /users/{id}/playlists/liked_and_owned`, two pages: own and liked playlists, a private one with its share token, one without a link, a system playlist to skip, an untitled one and a duplicate on the second page. |
| `my-own-playlists.json`                              | api-v2 `GET /users/{id}/playlists_without_albums`: the account's own playlists as bare playlist objects, one private, one also present in the liked listing.                                                                   |
| `my-library.json`                                    | api-v2 `GET /me/library/all`: the signed-in library, the one listing that includes the account's private playlists, plus a system playlist to skip and a like.                                                                 |
