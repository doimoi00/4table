const prevHandler = global.ErrorUtils.getGlobalHandler();
global.ErrorUtils.setGlobalHandler((error: Error, isFatal: boolean) => {
  console.error(
    `[GlobalError][${isFatal ? 'FATAL' : 'NON-FATAL'}]\n` +
    `  ${error.message}\n` +
    `  ${error.stack}`
  );
  prevHandler(error, isFatal);
});
