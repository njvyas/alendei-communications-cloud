/**
 * Shared design-system primitives (U15.1). Colours come only from the `--acc-*`
 * tokens in `src/app/globals.css`.
 */
export { Button, IconButton, Spinner, buttonVariants } from './button';
export type { ButtonProps, ButtonSize, ButtonVariant, IconButtonProps } from './button';
export { Input, PasswordInput, SearchInput } from './input';
export type { InputProps, PasswordInputProps, SearchInputProps } from './input';
export { Select, computeMenuPosition, flattenOptions } from './select';
export type { SelectGroup, SelectItem, SelectOption, SelectProps } from './select';
export { Badge, StatusBadge } from './badge';
export type { BadgeProps, BadgeVariant, StatusBadgeProps } from './badge';
export { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from './card';
export { StatCard } from './stat-card';
export type { StatCardProps } from './stat-card';
export { Breadcrumb, breadcrumbsFromPath } from './breadcrumb';
export type { BreadcrumbItem, BreadcrumbLinkProps } from './breadcrumb';
export { Tabs, TabsContent, TabsList, TabsTrigger } from './tabs';
export type { TabsProps } from './tabs';
export { EmptyState } from './empty-state';
export type { EmptyStateProps } from './empty-state';
export { AccessibleDialog, useModalDialog } from './dialog';
export type { AccessibleDialogProps, ModalDialogController } from './dialog';
export { Drawer } from './drawer';
export type { DrawerProps } from './drawer';
export { ToastCard, ToastContainer } from './toast';
export { ActionFeedback } from './action-feedback';
export type { ActionFeedbackMessage, ActionFeedbackProps } from './action-feedback';
export { ThemePreferenceControl } from './theme-preference-control';
export * from './data-table';
