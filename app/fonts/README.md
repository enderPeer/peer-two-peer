# The three typefaces, vendored

Michroma, Outfit and Instrument Serif, latin subset, woff2. All three are
licensed under the SIL Open Font License 1.1, which permits redistribution.

**They are files in this repository and not a link to a font CDN, deliberately.**
The app claims it works offline and ships nothing to anybody else's server, and
a stylesheet that fetches `fonts.googleapis.com` would make both claims false —
it tells a third party the IP address of every reader, on every page load, before
a single picture has been shown. A network built so that no host has to be
trusted should not begin by handing a visitor's address to one that is not even
part of it.

`Outfit-var.woff2` is a single variable font covering weights 300–600. Google's
CSS API lists four static URLs for those weights and all four resolve to this one
file; keeping four copies would have been 96 KB of the same bytes.

71 KB in total, for the whole interface.

To refresh them, fetch the `latin` block of each family from
`https://fonts.googleapis.com/css2?family=…&display=swap` and save the woff2 it
names. Check the first four bytes are `wOF2` before committing: a rate-limited
request returns an HTML error page with a .woff2 name, which is how the first
attempt at this quietly wrote four identical 1,635-byte pages of markup.
