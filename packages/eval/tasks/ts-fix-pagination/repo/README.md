# list-pager

Pagination helpers shared by the product list and the order history screens.

```
npm install
npm test
npm run typecheck
```

`paginate(items, page, pageSize)` takes a 1-based page number. `describePage`
produces the "Showing 6-10 of 23" caption from its result.
