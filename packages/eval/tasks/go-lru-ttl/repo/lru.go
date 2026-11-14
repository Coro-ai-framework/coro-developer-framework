// Package cache holds the small in-process caches the services share.
package cache

import "container/list"

type entry struct {
	key   string
	value any
}

// LRU is a fixed-capacity cache that evicts the least recently used entry
// when it is full.
type LRU struct {
	capacity int
	order    *list.List // front is the most recently used
	items    map[string]*list.Element
}

// NewLRU returns an empty cache that holds at most capacity entries.
// It panics if capacity is less than 1.
func NewLRU(capacity int) *LRU {
	if capacity < 1 {
		panic("cache: capacity must be at least 1")
	}
	return &LRU{
		capacity: capacity,
		order:    list.New(),
		items:    make(map[string]*list.Element, capacity),
	}
}

// Get returns the value stored under key and marks it as most recently used.
func (c *LRU) Get(key string) (any, bool) {
	el, ok := c.items[key]
	if !ok {
		return nil, false
	}
	c.order.MoveToFront(el)
	return el.Value.(*entry).value, true
}

// Put stores value under key, replacing any existing value and marking the
// entry as most recently used. If the cache is full the least recently used
// entry is evicted.
func (c *LRU) Put(key string, value any) {
	if el, ok := c.items[key]; ok {
		el.Value.(*entry).value = value
		c.order.MoveToFront(el)
		return
	}
	if c.order.Len() >= c.capacity {
		c.removeElement(c.order.Back())
	}
	c.items[key] = c.order.PushFront(&entry{key: key, value: value})
}

// Delete removes key and reports whether it was present.
func (c *LRU) Delete(key string) bool {
	el, ok := c.items[key]
	if !ok {
		return false
	}
	c.removeElement(el)
	return true
}

// Len returns the number of entries in the cache.
func (c *LRU) Len() int {
	return c.order.Len()
}

func (c *LRU) removeElement(el *list.Element) {
	c.order.Remove(el)
	delete(c.items, el.Value.(*entry).key)
}
