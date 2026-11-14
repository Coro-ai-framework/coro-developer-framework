package cache

import "testing"

func TestGetMissing(t *testing.T) {
	c := NewLRU(2)
	if _, ok := c.Get("a"); ok {
		t.Fatal("expected a miss on an empty cache")
	}
}

func TestPutAndGet(t *testing.T) {
	c := NewLRU(2)
	c.Put("a", 1)
	got, ok := c.Get("a")
	if !ok || got != 1 {
		t.Fatalf("Get(a) = %v, %v; want 1, true", got, ok)
	}
}

func TestPutReplacesValue(t *testing.T) {
	c := NewLRU(2)
	c.Put("a", 1)
	c.Put("a", 2)
	if got, _ := c.Get("a"); got != 2 {
		t.Fatalf("Get(a) = %v; want 2", got)
	}
	if c.Len() != 1 {
		t.Fatalf("Len() = %d; want 1", c.Len())
	}
}

func TestEvictsLeastRecentlyUsed(t *testing.T) {
	c := NewLRU(2)
	c.Put("a", 1)
	c.Put("b", 2)
	c.Get("a") // b is now the least recently used
	c.Put("c", 3)
	if _, ok := c.Get("b"); ok {
		t.Fatal("expected b to have been evicted")
	}
	if _, ok := c.Get("a"); !ok {
		t.Fatal("expected a to survive")
	}
	if _, ok := c.Get("c"); !ok {
		t.Fatal("expected c to be present")
	}
}

func TestDelete(t *testing.T) {
	c := NewLRU(2)
	c.Put("a", 1)
	if !c.Delete("a") {
		t.Fatal("Delete(a) = false; want true")
	}
	if c.Delete("a") {
		t.Fatal("Delete(a) = true on a missing key; want false")
	}
	if c.Len() != 0 {
		t.Fatalf("Len() = %d; want 0", c.Len())
	}
}

func TestNewLRURejectsBadCapacity(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("expected a panic for capacity 0")
		}
	}()
	NewLRU(0)
}
