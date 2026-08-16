package main

import "testing"

func TestDevelopmentVersionIsPresent(t *testing.T) {
	if version == "" {
		t.Fatal("version must not be empty")
	}
}
