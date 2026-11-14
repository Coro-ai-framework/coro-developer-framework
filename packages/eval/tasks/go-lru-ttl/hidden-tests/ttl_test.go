package hidden_test

import (
	"strconv"
	"sync"
	"testing"
	"time"

	"example.com/cache"
)

type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func newClock() *fakeClock {
	return &fakeClock{now: time.Date(2024, 1, 1, 0, 0, 0, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

func mustHit(t *testing.T, c *cache.LRU, key string, want any) {
	t.Helper()
	got, ok := c.Get(key)
	if !ok {
		t.Fatalf("Get(%q) missed; want a hit with %v", key, want)
	}
	if got != want {
		t.Fatalf("Get(%q) = %v; want %v", key, got, want)
	}
}

func mustMiss(t *testing.T, c *cache.LRU, key string) {
	t.Helper()
	if got, ok := c.Get(key); ok {
		t.Fatalf("Get(%q) = %v, true; want a miss", key, got)
	}
}

func TestEntryExpiresAtPutTimePlusTTL(t *testing.T) {
	clock := newClock()
	c := cache.NewLRU(10, cache.WithTTL(time.Minute), cache.WithClock(clock.Now))
	c.Put("a", 1)

	clock.Advance(59 * time.Second)
	mustHit(t, c, "a", 1)

	clock.Advance(time.Second)
	mustMiss(t, c, "a")
}

func TestGetDoesNotExtendTheTTL(t *testing.T) {
	clock := newClock()
	c := cache.NewLRU(10, cache.WithTTL(time.Minute), cache.WithClock(clock.Now))
	c.Put("a", 1)

	clock.Advance(30 * time.Second)
	mustHit(t, c, "a", 1)

	clock.Advance(30 * time.Second)
	mustMiss(t, c, "a")
}

func TestPutOnAnExistingKeyResetsTheExpiry(t *testing.T) {
	clock := newClock()
	c := cache.NewLRU(10, cache.WithTTL(time.Minute), cache.WithClock(clock.Now))
	c.Put("a", 1)

	clock.Advance(40 * time.Second)
	c.Put("a", 2)

	clock.Advance(40 * time.Second) // 80s after the first Put, 40s after the second
	mustHit(t, c, "a", 2)

	clock.Advance(20 * time.Second)
	mustMiss(t, c, "a")
}

func TestPutWithTTLOverridesTheDefault(t *testing.T) {
	clock := newClock()
	c := cache.NewLRU(10, cache.WithTTL(time.Minute), cache.WithClock(clock.Now))
	c.PutWithTTL("short", 1, 10*time.Second)
	c.Put("default", 2)
	c.PutWithTTL("long", 3, time.Hour)

	clock.Advance(10 * time.Second)
	mustMiss(t, c, "short")
	mustHit(t, c, "default", 2)

	clock.Advance(time.Minute)
	mustMiss(t, c, "default")
	mustHit(t, c, "long", 3)
}

func TestPutWithTTLWorksWithoutADefault(t *testing.T) {
	clock := newClock()
	c := cache.NewLRU(10, cache.WithClock(clock.Now))
	c.PutWithTTL("temp", 1, 5*time.Second)
	c.Put("forever", 2)

	clock.Advance(5 * time.Second)
	mustMiss(t, c, "temp")
	mustHit(t, c, "forever", 2)
}

func TestZeroOrNegativeTTLNeverExpires(t *testing.T) {
	clock := newClock()
	c := cache.NewLRU(10, cache.WithTTL(time.Minute), cache.WithClock(clock.Now))
	c.PutWithTTL("zero", 1, 0)
	c.PutWithTTL("negative", 2, -time.Second)

	clock.Advance(24 * time.Hour)
	mustHit(t, c, "zero", 1)
	mustHit(t, c, "negative", 2)

	negativeDefault := cache.NewLRU(10, cache.WithTTL(-time.Second), cache.WithClock(clock.Now))
	negativeDefault.Put("a", 1)
	clock.Advance(24 * time.Hour)
	mustHit(t, negativeDefault, "a", 1)
}

func TestNoTTLByDefault(t *testing.T) {
	clock := newClock()
	c := cache.NewLRU(10, cache.WithClock(clock.Now))
	c.Put("a", 1)
	clock.Advance(1000 * time.Hour)
	mustHit(t, c, "a", 1)
}

func TestReplacingAnEntryReplacesItsExpiry(t *testing.T) {
	clock := newClock()
	c := cache.NewLRU(10, cache.WithTTL(time.Minute), cache.WithClock(clock.Now))
	c.Put("a", 1)
	c.PutWithTTL("a", 2, 0) // now never expires

	clock.Advance(10 * time.Minute)
	mustHit(t, c, "a", 2)

	c.PutWithTTL("b", 3, time.Hour)
	c.Put("b", 4) // back to the one-minute default
	clock.Advance(time.Minute)
	mustMiss(t, c, "b")
}

func TestLenDoesNotCountExpiredEntries(t *testing.T) {
	clock := newClock()
	c := cache.NewLRU(10, cache.WithClock(clock.Now))
	c.PutWithTTL("a", 1, 10*time.Second)
	c.PutWithTTL("b", 2, 20*time.Second)
	c.Put("c", 3)
	if got := c.Len(); got != 3 {
		t.Fatalf("Len() = %d; want 3", got)
	}

	clock.Advance(10 * time.Second)
	if got := c.Len(); got != 2 {
		t.Fatalf("Len() after a expired = %d; want 2", got)
	}

	clock.Advance(10 * time.Second)
	if got := c.Len(); got != 1 {
		t.Fatalf("Len() after b expired = %d; want 1", got)
	}
}

func TestDeleteTreatsAnExpiredEntryAsGone(t *testing.T) {
	clock := newClock()
	c := cache.NewLRU(10, cache.WithTTL(time.Minute), cache.WithClock(clock.Now))
	c.Put("live", 1)
	c.PutWithTTL("dead", 2, time.Second)

	clock.Advance(2 * time.Second)
	if c.Delete("dead") {
		t.Fatal("Delete(dead) = true for an expired entry; want false")
	}
	if !c.Delete("live") {
		t.Fatal("Delete(live) = false; want true")
	}
}

func TestEvictionDropsExpiredEntriesBeforeTheLeastRecentlyUsed(t *testing.T) {
	clock := newClock()
	c := cache.NewLRU(2, cache.WithClock(clock.Now))
	c.PutWithTTL("a", 1, 10*time.Second)
	c.Put("b", 2)
	mustHit(t, c, "a", 1) // a is now the most recently used, b the least

	clock.Advance(11 * time.Second) // a has expired
	c.Put("c", 3)                   // needs room: a goes, not b

	mustHit(t, c, "b", 2)
	mustHit(t, c, "c", 3)
	if got := c.Len(); got != 2 {
		t.Fatalf("Len() = %d; want 2", got)
	}
}

func TestLeastRecentlyUsedStillEvictsWhenNothingHasExpired(t *testing.T) {
	clock := newClock()
	c := cache.NewLRU(2, cache.WithTTL(time.Hour), cache.WithClock(clock.Now))
	c.Put("a", 1)
	c.Put("b", 2)
	mustHit(t, c, "a", 1)
	c.Put("c", 3)

	mustMiss(t, c, "b")
	mustHit(t, c, "a", 1)
	mustHit(t, c, "c", 3)
}

func TestCapacityIsNeverExceeded(t *testing.T) {
	clock := newClock()
	c := cache.NewLRU(10, cache.WithTTL(time.Minute), cache.WithClock(clock.Now))
	for i := 0; i < 100; i++ {
		c.Put(strconv.Itoa(i), i)
		if i%7 == 0 {
			clock.Advance(20 * time.Second)
		}
		if got := c.Len(); got > 10 {
			t.Fatalf("Len() = %d after %d puts; capacity is 10", got, i+1)
		}
	}
}

func TestNewLRUWithoutOptionsStillWorks(t *testing.T) {
	c := cache.NewLRU(1)
	c.Put("a", 1)
	c.Put("b", 2)
	mustMiss(t, c, "a")
	mustHit(t, c, "b", 2)
}

func TestSafeForConcurrentUse(t *testing.T) {
	clock := newClock()
	c := cache.NewLRU(50, cache.WithTTL(time.Second), cache.WithClock(clock.Now))

	var wg sync.WaitGroup
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func(g int) {
			defer wg.Done()
			for i := 0; i < 2000; i++ {
				key := strconv.Itoa((g*31 + i) % 80)
				switch i % 5 {
				case 0:
					c.Put(key, i)
				case 1:
					c.PutWithTTL(key, i, 3*time.Second)
				case 2:
					c.Get(key)
				case 3:
					c.Delete(key)
				default:
					c.Len()
					clock.Advance(time.Millisecond)
				}
			}
		}(g)
	}
	wg.Wait()

	if got := c.Len(); got > 50 {
		t.Fatalf("Len() = %d; capacity is 50", got)
	}
}
