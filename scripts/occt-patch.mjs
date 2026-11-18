// Start-up patch for opencascade.js's JavaScript glue (the WASM is not touched).
//
// Embind builds one JavaScript invoker per bound C++ method and constructor with `new Function` while the module
// starts: tens of thousands of them for the full OpenCASCADE build, about half of a worker's 4 to 5 s set-up, and
// most are never called. The patch makes each invoker on its first call instead; calls behave the same (the
// argument count check, `this`, return values and destructors are the generated code's own).
const FROM = "function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc){";
const TO = "function craftInvokerFunction(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc){var made=null;return function(){return(made||(made=craftInvokerFunctionNow(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc))).apply(this,arguments)}}function craftInvokerFunctionNow(humanName,argTypes,classType,cppInvokerFunc,cppTargetFunc){";

/** The patched glue, or null when this build's glue does not have the expected function (copy it unpatched). */
export function patchOcctGlue(text) {
  const i = text.indexOf(FROM);
  if (i < 0 || text.indexOf(FROM, i + 1) >= 0 || text.includes("craftInvokerFunctionNow")) return null;
  return text.slice(0, i) + TO + text.slice(i + FROM.length);
}
