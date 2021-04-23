# aip: Async Iterable Pipeline

[Vitaly Akimov's article](https://medium.com/dailyjs/decoupling-business-logic-using-async-generators-cc257f80ab33)
laid out an interesting approach to decoupling business logic based on
[es2018 async generator syntax](https://kangax.github.io/compat-table/es2016plus/#test-Asynchronous_Iterators).
What stood out to me is the opportunity to get more flexibility without paying
extra. Looks like it is possible to write your code in reactive programming
manner without having to actually load something as big as RxJS (or similar)
library. Even better: in this case it seems that smaller library means smaller
API surface to learn.

Of course all the aforementioned benefits are balanced by corresponding
drawbacks like having to use less expressive idioms or the need to "re-invent
wheel" at times. It's all about trade-offs (as usual). But I think that it's
good to have an option of using smallest possible library that attempts to
offload most of it's API onto the programming language itself.

So this library is my take on the approach described above, and it seems like it
is a success: minified and gzipped version of this library is just a touch more
than a kilobyte. Most of the library source is very similar to code from the
[article cited](https://medium.com/dailyjs/decoupling-business-logic-using-async-generators-cc257f80ab33).
I basically only tried to add a bit of readability and sensible interfaces on
top.

## Documentation

Library API description is available on
[Deno documentation viewer](https://doc.deno.land/https/deno.land/x/aip/mod.ts).
But since this library is so small you probably better off just taking a look at
the source code (it's less than 300 lines, fairly readable and contains comments
on most important parts of API). Tests might also be useful to look at as well.
You can also take a look at
[completed example from the article (modified to use
`aip`)](https://jsfiddle.net/27v1p8gz/).
