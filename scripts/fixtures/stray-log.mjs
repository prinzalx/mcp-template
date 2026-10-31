// Preloaded into the server (`node --import`) by smoke-stdio. A tool that prints with console.log
// would corrupt the stdio protocol; the kernel redirects console.log to stderr, and this fixture
// proves it: if the guard were gone, this line would land on stdout and fail the purity check.
setTimeout(() => {
  console.log("STRAY LINE THAT MUST NOT REACH STDOUT");
}, 600);
