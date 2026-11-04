# Recording the demo GIF

The README links to `docs/demo.gif`. Record it with [vhs](https://github.com/charmbracelet/vhs)
(preferred, reproducible) or asciinema. Run against a copy of transcripts you are happy to show,
or against the test fixtures so no project names or paths appear.

## vhs

Save as `docs/demo.tape`, then run `vhs docs/demo.tape` from the repository root.

```tape
Output docs/demo.gif
Set FontSize 14
Set Width 1100
Set Height 620
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms

Type "npx ccautopsy --since 7d"
Enter
Sleep 4s
Type "npx ccautopsy --session 49fbda50"
Enter
Sleep 4s
Type "npx ccautopsy --json | head -20"
Enter
Sleep 3s
```

Replace `49fbda50` with a session id prefix from your own `Worst sessions` list.
To record against fixtures only: `Type "node dist/cli.js test/fixtures"`.

## asciinema (alternative)

```sh
asciinema rec docs/demo.cast -c "npx ccautopsy --since 7d"
# convert to GIF with agg:
agg docs/demo.cast docs/demo.gif --font-size 14
```

Check the output before committing: the summary view prints working-directory paths next to the
worst sessions. Record from a throwaway directory name if you do not want yours shown.
