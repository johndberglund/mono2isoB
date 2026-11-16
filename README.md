# mono2iso: single tiles for 2-isohedral types

An explorer for the **1,270 Euclidean 2-isohedral tiling types** (Delgado, Huson and Zamorzaeva): for each type, can one
tile shape fill both tile classes? Where a single tile is known, see it; where none is, search for one.

## The tabs

- **Explore**: pick a type by its `k_q n_r` signature, its orbifold, the paper's order or its Tegula number. The card says
  what is known: possible (a tile is known), impossible (with the proof picture), or unknown, and how far it has been
  searched. **Explore this type** walks through its combos (size m, sum-type, orientation, offset), opens a combo's shape,
  lets you drag it and design its curves, and runs a **deeper search** on that one combo.
- **Copy tiling**: looking at a tiling in a paper or a drawing? Count how many sides of the tile each edge spans, per tile class
  (e.g. `8,6,1,11,8 / 8,8,1,8,8,1`), and it finds which combo of which type it is.
- **Gallery**: every anisohedral tile found so far, grouped so that a tile sits under the more general tile it is a special
  case of. It can be saved as one PDF.
- **Deep search**: search a type over a range of sizes in your browser. Results are kept in the browser and can be saved
  as a file.

Everything runs in the browser from static files: open `index.html`, or serve the folder with any static web server.
Link to a type with `index.html#<id>`.

## Searching from the command line

The same search the Deep search tab runs, for runs that should go all night (needs [Node.js](https://nodejs.org/)):

```
node tools/deep_search.js --id 25546 --from 56 --to 70
```

Results go to `deep_results/<id>/`, and a run can be stopped and resumed. The options are listed at the top of
`tools/deep_search.js`.

## What the words mean

- **anisohedral**: one tile, two classes of tiles in the tiling, and the tiling is not isohedral.
- **unknown / deep search found no tile**: we did not find one. Never "there is none"; only a proof says that.
- **impossible**: proven for every shape of the type, with the proof shown on the card.

## Related

The impossibility proofs, and a builder for making new ones, are at
[banMonoTest](https://johndberglund.github.io/banMonoTest/).

## License

Code: [GNU GPL version 3](LICENSE). Parts of the engine follow Tegula (Huson, Zeller, Westphal; GPL-3), see [NOTICE.md](NOTICE.md).
Pictures (the type figures in `figures_own/` and the proof pictures in `proofs/`), data and write-ups: [CC BY 4.0](LICENSE-CONTENT.md).
