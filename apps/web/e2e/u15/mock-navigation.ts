export const useRouter = () => ({
  push: (_href: string) => {},
  replace: (_href: string) => {},
  prefetch: () => {},
  back: () => {},
  forward: () => {},
  refresh: () => {},
});

export const usePathname = () => '/';
export const useSearchParams = () => new URLSearchParams();
