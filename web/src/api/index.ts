import axios from 'axios';
import { clearToken, getToken } from '../token';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || (import.meta.env.BASE_URL || '/').replace(/\/$/, ''),
  timeout: 30000
});

api.interceptors.request.use(config => {
  const token = getToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  response => response,
  error => {
    if (error.response?.status === 401) {
      clearToken();
      window.location.href = (import.meta.env.BASE_URL || '/') + 'login';
    }
    return Promise.reject(error);
  }
);

export default api;