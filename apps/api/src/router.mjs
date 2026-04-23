export function createRouter() {
  const routes = [];

  function addRoute(config) {
    routes.push(config);
  }

  function match(method, pathname) {
    const methodUpper = method.toUpperCase();
    for (const route of routes) {
      if (route.method !== methodUpper) {
        continue;
      }
      const params = matchPath(route.path, pathname);
      if (params) {
        return { route, params };
      }
    }
    return null;
  }

  return {
    addRoute,
    match,
    routes
  };
}

function matchPath(pattern, pathname) {
  const patternSegments = pattern.split("/").filter(Boolean);
  const pathSegments = pathname.split("/").filter(Boolean);
  if (patternSegments.length !== pathSegments.length) {
    return null;
  }

  const params = {};
  for (let index = 0; index < patternSegments.length; index += 1) {
    const patternSegment = patternSegments[index];
    const pathSegment = pathSegments[index];
    if (patternSegment.startsWith(":")) {
      params[patternSegment.slice(1)] = decodeURIComponent(pathSegment);
      continue;
    }
    if (patternSegment !== pathSegment) {
      return null;
    }
  }

  return params;
}
