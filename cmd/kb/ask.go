package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"strings"

	"github.com/AlexS8332/AnimalGuide_Task23/internal/llm"
	"github.com/AlexS8332/AnimalGuide_Task23/internal/rag"
)

func init() {
	register("ask", "спросить отвечающего агента: ответ без базы и с базой знаний рядом, найденные фрагменты, цена", runAsk)
}

func runAsk(ctx context.Context, args []string, out, errOut io.Writer) int {
	fs := newFlagSet("ask", `[флаги] "вопрос"`, errOut)
	mode := fs.String("mode", "both", "режим: norag (без базы), rag (с базой) или both")
	var prior listFlag
	fs.Var(&prior, "context", "предыдущая реплика пользователя (вопрос-продолжение); флаг можно повторять")
	af := newAnswerFlags(fs)
	// Вопрос — позиционный аргумент; флаги можно писать и после него.
	var query []string
	rest := args
	for {
		if err := fs.Parse(rest); err != nil {
			if errors.Is(err, flag.ErrHelp) {
				return exitOK
			}
			return exitUsage
		}
		if fs.NArg() == 0 {
			break
		}
		query = append(query, fs.Arg(0))
		rest = fs.Args()[1:]
	}
	q := strings.TrimSpace(strings.Join(query, " "))
	if q == "" {
		fmt.Fprintln(errOut, "ошибка: нет вопроса")
		fs.Usage()
		return exitUsage
	}
	modes, err := parseModes(*mode)
	if err != nil {
		fmt.Fprintln(errOut, "ошибка:", err)
		return exitUsage
	}
	a, closeKB, code := af.answerer(ctx, hasMode(modes, rag.RAG), errOut)
	if code >= 0 {
		return code
	}
	defer closeKB()

	question := rag.Question{Text: q, Context: prior}
	var total llm.Cost
	for i, m := range modes {
		if i > 0 {
			fmt.Fprintln(out)
		}
		ans, err := a.Answer(ctx, question, m)
		if err != nil {
			fmt.Fprintln(errOut, "ошибка:", err)
			return exitFailed
		}
		total = total.Add(ans.Cost)
		fmt.Fprintf(out, "== %s ==\n", m)
		if m == rag.RAG {
			line := fmt.Sprintf("Найдено (%s, %s", ans.Search.Index, ans.Search.Mode)
			if ans.Search.Embedder != "" {
				line += " " + ans.Search.Embedder
			}
			if ans.Search.Fallback != "" {
				line += ", откат: " + ans.Search.Fallback
			}
			fmt.Fprintf(out, "%s, %.1f мс):\n", line, ans.Search.Millis)
			if len(ans.Hits) == 0 {
				fmt.Fprintln(out, "  ничего не найдено")
			}
			for _, h := range ans.Hits {
				path := h.Section
				if len(h.Path) > 0 {
					path = strings.Join(h.Path, " › ")
				}
				fmt.Fprintf(out, "%2d. %.3f  %-28s %s › %s\n", h.Rank, h.Score, h.ID, h.Title, path)
			}
			fmt.Fprintln(out)
		}
		fmt.Fprintln(out, ans.Text)
		fmt.Fprintf(out, "(%s; токены %d → %d, из кэша %d; %s; %d мс)\n", a.Model, ans.Usage.Prompt, ans.Usage.Completion,
			ans.Usage.CacheHit, usd(ans.Cost), ans.Millis)
	}
	if len(modes) > 1 {
		fmt.Fprintf(out, "\nИтого: %s\n", usd(total))
	}
	return exitOK
}
