import { IsEmail, IsString, MaxLength, MinLength } from 'class-validator';

export class LoginDto {
  @IsEmail({}, { message: 'A valid email address is required' })
  @MaxLength(320)
  email!: string;

  /**
   * Bounded to keep an enormous body from becoming an Argon2id denial-of-service
   * vector. The lower bound is deliberately permissive — rejecting a short
   * password here with a distinct error would leak whether the account's real
   * password is short.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  password!: string;
}
