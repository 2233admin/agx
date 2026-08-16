package domain

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProductionDomainHasNoSideEffectImportsOrTaskHistoryTypes(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("ReadDir() error = %v", err)
	}
	disallowedImports := map[string]bool{
		"io":            true,
		"io/fs":         true,
		"net/http":      true,
		"os":            true,
		"os/exec":       true,
		"path/filepath": true,
	}

	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(token.NewFileSet(), filepath.Clean(name), nil, 0)
		if err != nil {
			t.Fatalf("ParseFile(%q) error = %v", name, err)
		}
		for _, imported := range file.Imports {
			path := strings.Trim(imported.Path.Value, `"`)
			if disallowedImports[path] {
				t.Errorf("production domain imports disallowed side-effect package %q", path)
			}
		}
		ast.Inspect(file, func(node ast.Node) bool {
			typeSpec, ok := node.(*ast.TypeSpec)
			if !ok {
				return true
			}
			if strings.Contains(typeSpec.Name.Name, "Task") || strings.Contains(typeSpec.Name.Name, "History") {
				t.Errorf("production domain declares prohibited type %q", typeSpec.Name.Name)
			}
			return true
		})
	}
}
