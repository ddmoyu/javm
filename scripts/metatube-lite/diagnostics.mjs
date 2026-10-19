import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
export async function applyMovieDiagnostics(source) {
  async function patch(file, replacements) {
    const target = path.join(source, file);
    let text = (await readFile(target, "utf8")).replaceAll("\r\n", "\n");
    for (const [before, after] of replacements) {
      if (text.split(before).length !== 2) throw new Error(`MetaTube 诊断补丁不匹配：${file}`);
      text = text.replace(before, after);
    }
    await writeFile(target, text);
  }
  await patch("engine/movie.go", [
    ['\t"fmt"\n', ""],
    ['\t"strings"\n', ""],
    [
      "SearchMovie(keyword, name string, fallback bool)",
      "SearchMovie(keyword, name string, fallback bool, diagnostics ...func(MovieDiagnostic))",
    ],
    [
      "\treturn e.searchMovie(keyword, provider, fallback)",
      "\tstarted := time.Now()\n\tresults, err := e.searchMovie(keyword, provider, fallback)\n\temitMovieDiagnostic(diagnostics, NewMovieDiagnostic(provider.Name(), results, err, time.Since(started)))\n\treturn results, err",
    ],
    [
      "searchMovieAll(keyword string)",
      "searchMovieAll(keyword string, diagnostics ...func(MovieDiagnostic))",
    ],
    [
      "SearchMovieAll(keyword string, fallback bool)",
      "SearchMovieAll(keyword string, fallback bool, diagnostics ...func(MovieDiagnostic))",
    ],
    ["e.searchMovieAll(keyword)", "e.searchMovieAll(keyword, diagnostics...)"],
    [
      "\terr = mt.ErrIncompleteMetadata",
      "\terr = &incompleteMovieMetadata{fields: missingMovieFields(info)}",
    ],
    ["\tds := make([]string, 0, e.movieProviders.Len())\n", ""],
    [
      '\t\tds = append(ds, func(a, b, c any) string {\n\t\t\tif c == nil {\n\t\t\t\tc = "no error"\n\t\t\t}\n\t\t\treturn fmt.Sprintf("%s(%s):<%v>", a, b, c)\n\t\t}(\n\t\t\tresp.Provider.Name(),\n\t\t\tresp.EndTime.Sub(resp.StartTime),\n\t\t\tresp.Error,\n\t\t))',
      "\t\temitMovieDiagnostic(diagnostics, NewMovieDiagnostic(resp.Provider.Name(), resp.Results, resp.Error, resp.EndTime.Sub(resp.StartTime)))",
    ],
    ['\te.logger.Printf("Search keyword %s: %s", keyword, strings.Join(ds, " | "))\n', ""],
  ]);
  await patch("route/search.go", [
    ['\t"net/http"\n', '\t"net/http"\n\t"time"\n'],
    [
      "\t\tswitch typ {",
      "\t\tobserve := collectMovieDiagnostics(c, typ == movieSearchType)\n\t\tstarted := time.Now()\n\t\tswitch typ {",
    ],
    [
      "results, err = app.GetMovieInfoByURL(query.Q, true /* always lazy */)",
      'results, err = app.GetMovieInfoByURL(query.Q, true /* always lazy */)\n\t\t\t\tif observe != nil { observe(engine.NewMovieDiagnostic("MetaTube", results, err, time.Since(started))) }',
    ],
    [
      "app.SearchMovieAll(query.Q, query.Fallback)",
      "app.SearchMovieAll(query.Q, query.Fallback, observe)",
    ],
    [
      "app.SearchMovie(query.Q, query.Provider, query.Fallback)",
      "app.SearchMovie(query.Q, query.Provider, query.Fallback, observe)",
    ],
    [
      "&responseMessage{Data: results}",
      "&responseMessage{Data: results, Diagnostics: movieDiagnostics(c)}",
    ],
  ]);
  await patch("route/info.go", [
    ['\t"net/http"\n', '\t"net/http"\n\t"time"\n'],
    [
      "\t\tswitch typ {",
      "\t\tobserve := collectMovieDiagnostics(c, typ == movieInfoType)\n\t\tstarted := time.Now()\n\t\tswitch typ {",
    ],
    [
      "info, err = app.GetMovieInfoByProviderID(uri.AsProviderID(), query.Lazy)",
      "info, err = app.GetMovieInfoByProviderID(uri.AsProviderID(), query.Lazy)\n\t\t\tif observe != nil { observe(engine.NewMovieDiagnostic(uri.Provider, info, err, time.Since(started))) }",
    ],
    [
      "&responseMessage{Data: info}",
      "&responseMessage{Data: info, Diagnostics: movieDiagnostics(c)}",
    ],
  ]);
  await patch("route/route.go", [
    ["&responseMessage{Error: e}", "&responseMessage{Error: e, Diagnostics: movieDiagnostics(c)}"],
    [
      'Error: errors.New(code, fmt.Sprintf("%v", message)),',
      'Error: errors.New(code, fmt.Sprintf("%v", message)),\n\t\tDiagnostics: movieDiagnostics(c),',
    ],
    [
      "type responseMessage struct {",
      'type responseMessage struct {\n\tDiagnostics any `json:"diagnostics,omitempty"`',
    ],
  ]);
  for (const target of ["engine", "route"])
    await copyFile(
      path.join(directory, "diagnostics", `${target}.go`),
      path.join(source, target, "javm_diagnostics.go"),
    );
}
