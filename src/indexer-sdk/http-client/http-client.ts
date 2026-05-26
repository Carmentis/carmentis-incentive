let baseUrl = "";

export function setApiBaseUrl(url: string) {
    baseUrl = url.replace(/\/+$/, "");
}

export const customFetch = async <T>(
    url: string,
    {
        method,
        params,
        body,
    }: {
        method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
        params?: any;
        body?: any;
        responseType?: string;
    },
): Promise<T> => {
    let targetUrl = `${baseUrl}${url}`;

    if (params) {
        targetUrl += '?' + new URLSearchParams(params);
    }

    const response = await fetch(targetUrl, {
        method,
        body,
    });

    const data = await response.json();

    return {
        data,
        status: response.status,
        headers: response.headers,
    } as T;
};
